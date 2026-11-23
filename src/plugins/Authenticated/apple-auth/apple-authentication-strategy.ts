import {
    AuthenticationStrategy,
    ExternalAuthenticationService,
    Injector,
    Logger,
    RequestContext,
    User,
    EventBus,
    AccountRegistrationEvent,
    UserService,
    CustomerService,
    ChannelService,
    Customer,
    TransactionalConnection,
    ExternalAuthenticationMethod,
    ID,
} from '@vendure/core';
import { verifyIdToken } from 'apple-signin-auth';
import type { AppleIdTokenType } from 'apple-signin-auth';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';
import {
    resolveBrandChannelIds,
    syncCustomerChannelsOnLogin,
} from '../shared/brand-channel-groups';

const loggerCtx = 'AppleAuthStrategy';

/**
 * Maps one or more channel tokens to an Apple Client ID (Bundle ID or Service ID).
 * Use one entry per brand / iOS app.
 */
export interface AppleChannelConfig {
    /** Vendure channel tokens that belong to this Apple app (case-insensitive). */
    channelTokens: string[];
    /**
     * Apple Service ID (web) or App Bundle ID (iOS) registered in Apple Developer Console.
     * e.g. "com.southmithai.app"
     */
    clientId: string;
}

export type AppleAuthData = {
    /** The identity token returned by Apple Sign In (JWT). */
    token: string;
    /** First name — read from credential.givenName in Flutter (only available on first sign-in). */
    firstName?: string;
    /** Last name — read from credential.familyName in Flutter (only available on first sign-in). */
    lastName?: string;
    /**
     * Email — pass credential.email from Flutter when available.
     * Apple only includes email in the JWT on first sign-in; this field is the fallback
     * so the backend can register new accounts even when the JWT has no email claim.
     */
    email?: string;
};

export class AppleAuthenticationStrategy implements AuthenticationStrategy<AppleAuthData> {
    readonly name = 'apple';

    private externalAuthenticationService: ExternalAuthenticationService;
    private eventBus: EventBus;
    private userService: UserService;
    private customerService: CustomerService;
    private channelService: ChannelService;
    private connection: TransactionalConnection;

    /**
     * @param channelConfigs - Array of channel-to-clientId mappings.
     *   Each entry covers one brand / iOS app.
     */
    constructor(private readonly channelConfigs: AppleChannelConfig[]) {}

    init(injector: Injector): void {
        this.externalAuthenticationService = injector.get(ExternalAuthenticationService);
        this.eventBus = injector.get(EventBus);
        this.userService = injector.get(UserService);
        this.customerService = injector.get(CustomerService);
        this.channelService = injector.get(ChannelService);
        this.connection = injector.get(TransactionalConnection);
    }

    defineInputType(): DocumentNode {
        return gql`
            input AppleAuthInput {
                token: String!
                firstName: String
                lastName: String
                email: String
            }
        `;
    }

    async authenticate(ctx: RequestContext, data: AppleAuthData): Promise<User | false> {
        const channelToken = ctx.channel.token;
        Logger.debug(`[Apple] authenticate() called. channel="${channelToken}"`, loggerCtx);

        const clientIds = this.resolveClientIds(channelToken);

        if (!clientIds.length) {
            const configured = this.channelConfigs.map(c => c.channelTokens.join('/')).join(', ');
            Logger.warn(
                `[Apple] No clientId for channel="${channelToken}". Configured channels: [${configured}]`,
                loggerCtx,
            );
            return false;
        }

        Logger.debug(`[Apple] Resolved clientIds=[${clientIds.join(', ')}] for channel="${channelToken}"`, loggerCtx);

        const payload = await this.verifyAppleToken(data.token, clientIds);
        if (!payload) {
            Logger.warn(`[Apple] Token verification failed. channel="${channelToken}" clientIds=[${clientIds.join(', ')}]`, loggerCtx);
            return false;
        }

        const appleUserId = payload.sub;
        // Use || (not ??) so that empty strings ("") from the client are also treated as "no email".
        // Apple JWT only includes email on the very first sign-in per device; after that it is undefined.
        let email: string | undefined = payload.email || data.email || undefined;
        const emailVerifiedFromToken = payload.email_verified === true || payload.email_verified === 'true';
        Logger.debug(`[Apple] Token payload: sub="${appleUserId}" email="${email ?? '(none)'}" source="${payload.email ? 'token' : data.email ? 'client' : 'none'}" email_verified="${payload.email_verified}"`, loggerCtx);

        // 1. DIRECT MATCH: existing Apple-linked account
        // Use a direct DB query (not channel-filtered) so returning users without email are found
        // even if they signed up on a different channel.
        Logger.debug(`[Apple] Step 1: Looking up existing Apple user by sub="${appleUserId}"`, loggerCtx);
        const existingAppleUser = await this.findUserByAppleSub(ctx, appleUserId);
        if (existingAppleUser) {
            Logger.debug(`[Apple] Direct match found: identifier="${existingAppleUser.identifier}"`, loggerCtx);
            if (!existingAppleUser.verified) {
                await this.connection.rawConnection
                    .getRepository(User)
                    .update(existingAppleUser.id, { verified: true });
                existingAppleUser.verified = true;
                Logger.info(`[Apple] Marked existing user id=${existingAppleUser.id} as verified (Sign In with Apple is the verification)`, loggerCtx);
            }
            // If the account was previously created with a synthetic email but Apple now
            // provides a real email (after user revoked and re-authorized), upgrade the email.
            if (email && this.isSyntheticEmail(existingAppleUser.identifier)) {
                Logger.info(`[Apple] Upgrading synthetic email to real email="${email}" for user id=${existingAppleUser.id}`, loggerCtx);
                await this.upgradeUserEmail(ctx, existingAppleUser.id, email);
            }
            await this.syncChannelPermissions(ctx, existingAppleUser.id);
            await this.handleSuccessfulLogin(ctx, existingAppleUser);
            return existingAppleUser;
        }
        Logger.debug(`[Apple] No direct Apple match found.`, loggerCtx);

        // 1b. EMAIL RECOVERY from soft-deleted account.
        // Mirrors Google behavior: the deleted account stays deleted; we recover the email
        // from the old identifier so Steps 2/3 can create a brand-new account.
        // Apple never re-sends email for a returning device, so this is the only way to get
        // the email when the JWT has no email claim.
        if (!email) {
            const deletedAppleUser = await this.findDeletedUserByAppleSub(ctx, appleUserId);
            if (!deletedAppleUser) {
                Logger.debug(`[Apple] Step 1b: No soft-deleted account found for sub="${appleUserId}"`, loggerCtx);
            } else {
                const recovered = deletedAppleUser.identifier;
                // Only use the identifier if it is a real (non-synthetic, non-freed) email.
                const isUsable = !!recovered &&
                    !this.isSyntheticEmail(recovered) &&
                    !recovered.includes('__deleted__');
                if (isUsable) {
                    email = recovered;
                    Logger.info(
                        `[Apple] Step 1b: Recovered email="${email}" from soft-deleted account id=${deletedAppleUser.id} — will create new account`,
                        loggerCtx,
                    );
                } else {
                    Logger.debug(
                        `[Apple] Step 1b: Deleted account id=${deletedAppleUser.id} found but identifier "${recovered}" is not a usable email — will use synthetic address`,
                        loggerCtx,
                    );
                }
            }
        }

        // 2. SMART LINK: same email exists (Phone OTP / Google / Native user)
        if (email) {
            Logger.debug(`[Apple] Step 2: Looking up existing user by email="${email}"`, loggerCtx);
            const existingEmailUser = await this.userService.getUserByEmailAddress(ctx, email);
            if (existingEmailUser) {
                Logger.debug(`[Apple] Smart-link: linking Apple to existing user="${existingEmailUser.identifier}"`, loggerCtx);
                await this.linkUserToApple(ctx, existingEmailUser, appleUserId);
                if (!existingEmailUser.verified) {
                    await this.connection.rawConnection
                        .getRepository(User)
                        .update(existingEmailUser.id, { verified: true });
                    existingEmailUser.verified = true;
                    Logger.info(`[Apple] Marked smart-linked user id=${existingEmailUser.id} as verified`, loggerCtx);
                }
                await this.syncChannelPermissions(ctx, existingEmailUser.id);
                await this.handleSuccessfulLogin(ctx, existingEmailUser);
                return existingEmailUser;
            }
            Logger.debug(`[Apple] No existing email user found.`, loggerCtx);
        } else {
            Logger.debug(`[Apple] Step 2 skipped: no email in token.`, loggerCtx);
        }

        // 3. NEW USER: create fresh account
        // Apple only includes email in the JWT on the very first sign-in per device.
        // After that, the JWT never carries email again. If no email was obtained from
        // the token, the frontend, or a soft-deleted record, synthesize a unique address
        // from the Apple sub — the same pattern PhoneOTP uses for phone-number accounts.
        const resolvedEmail = email || `apple.${appleUserId.replace(/[^a-z0-9]/gi, '_').toLowerCase()}@privaterelay.appleid.com`;
        if (!email) {
            Logger.info(
                `[Apple] No email available — using synthesized address "${resolvedEmail}" for sub="${appleUserId}"`,
                loggerCtx,
            );
        }

        // Free the identifier if a soft-deleted user already owns this email/sub address.
        // Without this, createCustomerAndUser throws a unique-constraint error because
        // the deleted user's row still occupies the identifier slot.
        await this.freeDeletedIdentifier(resolvedEmail);

        const firstName = data.firstName ?? '';
        const lastName = data.lastName ?? '';
        Logger.debug(`[Apple] Step 3: Creating new user for email="${resolvedEmail}" firstName="${firstName}" lastName="${lastName}" emailVerified=${emailVerifiedFromToken}`, loggerCtx);
        const newUser = await this.externalAuthenticationService.createCustomerAndUser(ctx, {
            strategy: this.name,
            externalIdentifier: appleUserId,
            verified: true,
            emailAddress: resolvedEmail,
            firstName,
            lastName,
        });

        if (newUser) {
            Logger.debug(`[Apple] New user created: identifier="${newUser.identifier}" on channel="${channelToken}"`, loggerCtx);
            await this.syncChannelPermissions(ctx, newUser.id);
            await this.handleSuccessfulLogin(ctx, newUser);
            await this.eventBus.publish(new AccountRegistrationEvent(ctx, newUser));
        }

        return newUser;
    }

    // --- HELPERS ---

    /**
     * Finds all Apple clientIds that match the current channel token (case-insensitive).
     * A channel may be served by multiple apps (e.g. Kaaikani app + Swadkerala app),
     * each with its own Bundle ID / client ID.
     */
    private resolveClientIds(channelToken: string): string[] {
        const lower = channelToken.toLowerCase();
        const ids = new Set<string>();
        for (const cfg of this.channelConfigs) {
            if (cfg.channelTokens.some((t) => t.toLowerCase() === lower)) {
                ids.add(cfg.clientId);
            }
        }
        return [...ids];
    }

    /**
     * Tries to verify the Apple token against each candidate clientId.
     * Returns the first successful result, or null if none match.
     */
    private async verifyAppleToken(
        token: string,
        clientIds: string[],
    ): Promise<AppleIdTokenType | null> {
        for (const clientId of clientIds) {
            Logger.debug(`[Apple] Verifying token for clientId="${clientId}"`, loggerCtx);
            try {
                const result = await verifyIdToken(token, {
                    audience: clientId,
                    ignoreExpiration: false,
                });
                Logger.debug(
                    `[Apple] Token verified. sub="${result.sub}" email="${result.email}" aud="${result.aud}"`,
                    loggerCtx,
                );
                return result;
            } catch (err) {
                Logger.warn(`[Apple] Token verification failed for clientId="${clientId}": ${err}`, loggerCtx);
            }
        }
        return null;
    }

    private async linkUserToApple(
        ctx: RequestContext,
        user: User,
        appleUserId: string,
    ): Promise<void> {
        const authRepo = this.connection.getRepository(ctx, ExternalAuthenticationMethod);
        const existing = await authRepo.findOne({
            where: {
                strategy: this.name,
                externalIdentifier: appleUserId,
                user: { id: user.id },
            },
        });
        if (!existing) {
            const method = await authRepo.save(
                new ExternalAuthenticationMethod({
                    strategy: this.name,
                    externalIdentifier: appleUserId,
                    user,
                }),
            );
            // AuthService saves this same User after authenticate() returns, and
            // TypeORM unlinks (userId = NULL) any method missing from the loaded
            // array, so without this the link never survived the login. Only a
            // loaded array is extended: setting one that was never loaded would
            // unlink the user's other methods (phone OTP) instead.
            if (user.authenticationMethods) {
                user.authenticationMethods = [...user.authenticationMethods, method];
            }
        }
    }

    /**
     * Finds a User by Apple sub WITHOUT channel filtering.
     * Vendure's built-in findCustomerUser() is channel-scoped, which means returning Apple
     * users (whose token has no email) won't be found if they originally registered on a
     * different channel. This direct query bypasses that limitation.
     */
    private async findUserByAppleSub(ctx: RequestContext, appleUserId: string): Promise<User | null> {
        // Use QueryBuilder to join directly on the authentication_method table.
        // This avoids TypeORM inherited-entity relation issues and bypasses channel filtering.
        const user = await this.connection.getRepository(ctx, User)
            .createQueryBuilder('user')
            .innerJoin(
                'authentication_method',
                'am',
                'am.userId = user.id AND am.strategy = :strategy AND am.externalIdentifier = :sub',
                { strategy: this.name, sub: appleUserId },
            )
            .where('user.deletedAt IS NULL')
            .orderBy('am.id', 'ASC')
            .limit(1)
            .getOne();
        Logger.debug(
            `[Apple] findUserByAppleSub sub="${appleUserId}" → found=${!!user}`,
            loggerCtx,
        );
        return user ?? null;
    }

    /** Finds a soft-deleted User linked to the given Apple sub. */
    private async findDeletedUserByAppleSub(_ctx: RequestContext, appleUserId: string): Promise<User | null> {
        const user = await this.connection.rawConnection
            .getRepository(User)
            .createQueryBuilder('user')
            .innerJoin(
                'authentication_method',
                'am',
                'am.userId = user.id AND am.strategy = :strategy AND am.externalIdentifier = :sub',
                { strategy: this.name, sub: appleUserId },
            )
            .where('user.deletedAt IS NOT NULL')
            .orderBy('am.id', 'DESC')
            .limit(1)
            .getOne();
        Logger.debug(
            `[Apple] findDeletedUserByAppleSub sub="${appleUserId}" → found=${!!user}`,
            loggerCtx,
        );
        return user ?? null;
    }

    /**
     * If a soft-deleted User still holds the given email as their identifier,
     * rename it (append __deleted__<timestamp>) so that createCustomerAndUser
     * can create a fresh account with the same email without hitting a unique-constraint error.
     */
    private async freeDeletedIdentifier(email: string): Promise<void> {
        const userRepo = this.connection.rawConnection.getRepository(User);
        const deletedUser = await userRepo.findOne({
            where: { identifier: email },
            withDeleted: true,
        });
        if (!deletedUser || !deletedUser.deletedAt) return;
        const freedIdentifier = `${email}__deleted__${Date.now()}`;
        await userRepo.update(deletedUser.id, { identifier: freedIdentifier });
        Logger.info(
            `[Apple] freeDeletedIdentifier: renamed identifier of deleted user id=${deletedUser.id} to "${freedIdentifier}"`,
            loggerCtx,
        );
    }

    /** Returns true if the identifier was auto-generated (not a real Apple email). */
    private isSyntheticEmail(identifier: string): boolean {
        return identifier.startsWith('apple.') && identifier.includes('@privaterelay.appleid.com');
    }

    /**
     * Replaces a synthetic email with the real email on both the User and Customer records.
     * Called when Apple finally provides a real email (after user revoked and re-authorized).
     */
    private async upgradeUserEmail(_ctx: RequestContext, userId: ID, realEmail: string): Promise<void> {
        try {
            const userRepo = this.connection.rawConnection.getRepository(User);
            const customerRepo = this.connection.rawConnection.getRepository(Customer);
            await userRepo.update(userId, { identifier: realEmail });
            await customerRepo.update({ user: { id: userId } }, { emailAddress: realEmail });
            Logger.info(`[Apple] upgradeUserEmail: updated user id=${userId} identifier to "${realEmail}"`, loggerCtx);
        } catch (err) {
            Logger.warn(`[Apple] upgradeUserEmail failed for user id=${userId}: ${err}`, loggerCtx);
        }
    }

    /**
     * Cancels any pending deletion request on login.
     */
    private async handleSuccessfulLogin(ctx: RequestContext, user: User): Promise<void> {
        const customer = await this.customerService.findOneByUserId(ctx, user.id);
        if (!customer) return;
        const customFields = customer.customFields as any;
        if (customFields.isDeletionRequested) {
            await this.customerService.update(ctx, {
                id: customer.id,
                customFields: {
                    isDeletionRequested: false,
                    deletionRequestReason: null,
                    deletionRequestedAt: null,
                },
            });
            Logger.info(`Cancelling deletion request for customer ${customer.id} due to Apple login`, loggerCtx);
        }
    }

    /** Assigns the customer to the single channel they authenticated on. */
    private async syncChannelPermissions(ctx: RequestContext, userId: ID): Promise<void> {
        // Not channel-filtered: this adds the customer to the current channel,
        // so the lookup must find customers who are not in it yet. See the
        // same method in the Google strategy.
        const customer = await this.customerService.findOneByUserId(ctx, userId, false);
        if (!customer) return;

        const channelIds = await resolveBrandChannelIds(ctx, this.channelService);

        if (channelIds.length > 0) {
            await syncCustomerChannelsOnLogin(
                this.channelService,
                ctx,
                customer.id,
                channelIds,
            );
        }
    }
}
