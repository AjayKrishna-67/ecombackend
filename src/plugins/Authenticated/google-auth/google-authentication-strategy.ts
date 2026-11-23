import {
  AuthenticationStrategy, ExternalAuthenticationService, Injector, Logger, RequestContext, User,
  EventBus, AccountRegistrationEvent, UserService, CustomerService, ChannelService,
  TransactionalConnection, ExternalAuthenticationMethod, ID
} from '@vendure/core';
import { OAuth2Client } from 'google-auth-library';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';
import {
  resolveBrandChannelIds,
  syncCustomerChannelsOnLogin,
} from '../shared/brand-channel-groups';

export type GoogleAuthData = { token: string; };

export class GoogleAuthenticationStrategy implements AuthenticationStrategy<GoogleAuthData> {
  readonly name = 'google';
  private client: OAuth2Client;
  private externalAuthenticationService: ExternalAuthenticationService;
  private eventBus: EventBus;
  private userService: UserService;
  private customerService: CustomerService;
  private channelService: ChannelService;
  private connection: TransactionalConnection;

  constructor(private clientId: string) {
    this.client = new OAuth2Client(clientId);
  }

  init(injector: Injector) {
    this.externalAuthenticationService = injector.get(ExternalAuthenticationService);
    this.eventBus = injector.get(EventBus);
    this.userService = injector.get(UserService);
    this.customerService = injector.get(CustomerService);
    this.channelService = injector.get(ChannelService);
    this.connection = injector.get(TransactionalConnection);
  }

  defineInputType(): DocumentNode {
    return gql`input GoogleAuthInput { token: String! }`;
  }

  async authenticate(ctx: RequestContext, data: GoogleAuthData): Promise<User | false> {
    const channelToken = ctx.channel.token;
    Logger.debug(`[Google] authenticate() called. channel="${channelToken}"`, 'GoogleAuthStrategy');

    const payload = await this.verifyGoogleToken(data.token);
    if (!payload || !payload.email) {
      Logger.warn(`[Google] No valid payload or missing email. Returning false.`, 'GoogleAuthStrategy');
      return false;
    }

    // 1. DIRECT MATCH: Google ID
    Logger.debug(`[Google] Step 1: Looking up existing Google user by sub="${payload.sub}"`, 'GoogleAuthStrategy');
    const existingGoogleUser = await this.externalAuthenticationService.findCustomerUser(ctx, this.name, payload.sub);
    if (existingGoogleUser) {
      Logger.debug(`[Google] Direct match found: identifier="${existingGoogleUser.identifier}"`, 'GoogleAuthStrategy');
      if (!existingGoogleUser.verified) {
        await this.connection.rawConnection
          .getRepository(User)
          .update(existingGoogleUser.id, { verified: true });
        existingGoogleUser.verified = true;
        Logger.info(`[Google] Marked existing user id=${existingGoogleUser.id} as verified`, 'GoogleAuthStrategy');
      }
      await this.syncChannelPermissions(ctx, existingGoogleUser.id);
      await this.handleSuccessfulLogin(ctx, existingGoogleUser);
      return existingGoogleUser;
    }
    Logger.debug(`[Google] No direct Google match found.`, 'GoogleAuthStrategy');

    // 2. SMART LINK: Email Match (The "Priority" Check)
    Logger.debug(`[Google] Step 2: Looking up existing user by email="${payload.email}"`, 'GoogleAuthStrategy');
    const existingEmailUser = await this.userService.getUserByEmailAddress(ctx, payload.email);
    if (existingEmailUser) {
      Logger.debug(`[Google] Smart-link: linking Google to existing user="${existingEmailUser.identifier}"`, 'GoogleAuthStrategy');
      await this.linkUserToGoogle(ctx, existingEmailUser, payload.sub);
      if (!existingEmailUser.verified) {
        await this.connection.rawConnection
          .getRepository(User)
          .update(existingEmailUser.id, { verified: true });
        existingEmailUser.verified = true;
        Logger.info(`[Google] Marked smart-linked user id=${existingEmailUser.id} as verified`, 'GoogleAuthStrategy');
      }
      await this.syncChannelPermissions(ctx, existingEmailUser.id);
      await this.handleSuccessfulLogin(ctx, existingEmailUser);
      return existingEmailUser;
    }
    Logger.debug(`[Google] No existing email user found.`, 'GoogleAuthStrategy');

    // 3. NEW USER: Create fresh account
    Logger.debug(`[Google] Step 3: Creating new user for email="${payload.email}"`, 'GoogleAuthStrategy');
    const newUser = await this.externalAuthenticationService.createCustomerAndUser(ctx, {
      strategy: this.name,
      externalIdentifier: payload.sub,
      verified: true,
      emailAddress: payload.email,
      firstName: payload.given_name ?? '',
      lastName: payload.family_name ?? '',
    });

    if (newUser) {
      Logger.debug(`[Google] New user created: identifier="${newUser.identifier}"`, 'GoogleAuthStrategy');
      await this.syncChannelPermissions(ctx, newUser.id);
      await this.handleSuccessfulLogin(ctx, newUser);
      const registrationEvent = new AccountRegistrationEvent(ctx, newUser);
      await this.eventBus.publish(registrationEvent);
    }
    return newUser;
  }

  // --- TOKEN VERIFICATION ---

  private async verifyGoogleToken(token: string): Promise<{ sub: string; email: string; email_verified?: boolean; given_name?: string; family_name?: string } | null> {
    Logger.debug(`[Google] Verifying token for clientId="${this.clientId}"`, 'GoogleAuthStrategy');
    try {
      const ticket = await this.client.verifyIdToken({ idToken: token, audience: this.clientId });
      const payload = ticket.getPayload() as any;
      Logger.debug(
        `[Google] Token verified. sub="${payload?.sub}" email="${payload?.email}"`,
        'GoogleAuthStrategy',
      );
      return payload;
    } catch (e) {
      Logger.warn(`[Google] Token verification failed: ${e}`, 'GoogleAuthStrategy');
      return null;
    }
  }

  // --- HELPERS ---

  private async linkUserToGoogle(ctx: RequestContext, user: User, googleSub: string) {
    const authRepo = this.connection.getRepository(ctx, ExternalAuthenticationMethod);
    const existingMethod = await authRepo.findOne({
        where: { strategy: this.name, externalIdentifier: googleSub, user: { id: user.id } }
    });
    if (!existingMethod) {
        const method = await authRepo.save(new ExternalAuthenticationMethod({
            strategy: this.name, externalIdentifier: googleSub, user: user
        }));
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

  private async syncChannelPermissions(ctx: RequestContext, userId: ID) {
      // Not channel-filtered: the whole point is to add the customer to the
      // current channel, so a lookup restricted to that channel misses exactly
      // the customers who need it. When it was filtered, a first login in a
      // new city skipped the sync, Vendure's order merge then could not find
      // the customer either, and the guest cart stayed without a customer —
      // "Cannot transition Order from AddingItems to ArrangingPayment".
      const customer = await this.customerService.findOneByUserId(ctx, userId, false);
      if (!customer) return;

      const targetChannelIds = await resolveBrandChannelIds(ctx, this.channelService);

      if (targetChannelIds.length > 0) {
        await syncCustomerChannelsOnLogin(
          this.channelService,
          ctx,
          customer.id,
          targetChannelIds,
        );
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
          Logger.info(`Cancelling deletion request for customer ${customer.id} due to Google login`, 'GoogleAuth');
      }
  }
}
