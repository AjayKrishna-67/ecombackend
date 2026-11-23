import { Injectable } from '@nestjs/common';
import {
  ChannelService,
  Customer,
  CustomerService,
  ExternalAuthenticationMethod,
  ExternalAuthenticationService,
  ID,
  RequestContext,
  TransactionalConnection,
  User,
} from '@vendure/core';
import { IsNull } from 'typeorm';

import { STRATEGY_PHONE_OTP } from '../otpmechanism/constants';
import { resolveBrandChannelIds, syncCustomerChannelsOnLogin } from './brand-channel-groups';

const DEFAULT_PLACEHOLDER_EMAIL_DOMAIN = 'kaikani.com';

/**
 * Identity of a customer whose phone ownership is already proven (by OTP or WhatsApp).
 * firstName/lastName must be strings — Vendure's createCustomerAndUser requires them;
 * pass '' when unknown.
 */
export interface PhoneCustomerInput {
  phoneNumber: string;
  firstName: string;
  lastName: string;
  emailAddress?: string;
}

/**
 * Finds the customer that owns an already-verified phone number, or creates one.
 *
 * Every phone-based login (SMS OTP, WhatsApp link) goes through here so a phone
 * number maps to exactly one account whichever way the customer arrives. That is
 * also why new accounts are always recorded under the phoneOtp external-auth
 * strategy, whichever strategy called this.
 */
@Injectable()
export class PhoneCustomerService {
  constructor(
    private readonly connection: TransactionalConnection,
    private readonly customerService: CustomerService,
    private readonly externalAuthenticationService: ExternalAuthenticationService,
    private readonly channelService: ChannelService,
  ) {}

  /**
   * Returns the user owning this phone (verified, channels synced, pending deletion
   * cancelled); creates customer + user if none exists. Call only AFTER the phone has
   * been verified.
   */
  async findOrCreateUser(ctx: RequestContext, input: PhoneCustomerInput): Promise<User> {
    const customerRepo = this.connection.getRepository(ctx, Customer);
    const activeCustomer = await customerRepo.findOne({
        where: { phoneNumber: input.phoneNumber, deletedAt: IsNull() },
        relations: ['user'],
        order: { createdAt: 'DESC' }
    });

    let phoneUser: User | undefined = activeCustomer?.user || undefined;

    if (!phoneUser) {
        const authRepo = this.connection.getRepository(ctx, ExternalAuthenticationMethod);
        const authMethod = await authRepo.findOne({
            where: {
                strategy: STRATEGY_PHONE_OTP,
                externalIdentifier: input.phoneNumber,
                user: { deletedAt: IsNull() }
            },
            relations: ['user']
        });
        phoneUser = authMethod?.user;
    }

    if (phoneUser) {
        let customer = activeCustomer;

        if (!customer) {
            customer = await customerRepo.findOne({
                where: { user: { id: phoneUser.id }, deletedAt: IsNull() }
            });
        }

        if (activeCustomer?.user && activeCustomer.user.id !== phoneUser.id) {
            const verifiedUser = await this.ensureUserVerified(ctx, activeCustomer.user);
            await this.syncChannelPermissions(ctx, verifiedUser.id);
            await this.handleSuccessfulLogin(ctx, verifiedUser);
            return verifiedUser;
        }

        if (customer) {
            const verifiedUser = await this.ensureUserVerified(ctx, phoneUser);
            await this.syncChannelPermissions(ctx, verifiedUser.id);
            await this.handleSuccessfulLogin(ctx, verifiedUser);
            return verifiedUser;
        }
    }

    try {
      const emailToUse = input.emailAddress || buildPlaceholderEmail(input.phoneNumber);
      const newUser = await this.externalAuthenticationService.createCustomerAndUser(ctx, {
        strategy: STRATEGY_PHONE_OTP,
        externalIdentifier: input.phoneNumber,
        verified: true,
        firstName: input.firstName,
        lastName: input.lastName,
        emailAddress: emailToUse,
      });

      const justCreated = await this.connection.getRepository(ctx, Customer).findOne({
        where: { user: { id: newUser.id }, deletedAt: IsNull() },
        relations: ['channels'],
      });
      console.log(
        `[PhoneOtpChannelTrace] POST-createCustomerAndUser customer=${justCreated?.id} ctx.channelId=${ctx.channelId} channels=[${(justCreated?.channels ?? []).map(c => c.id).join(',')}]`,
      );

      await this.syncChannelPermissions(ctx, newUser.id);

      const customer = await this.customerService.findOneByUserId(ctx, newUser.id);
      if (customer) {
        await this.customerService.update(ctx, {
            id: customer.id,
            phoneNumber: input.phoneNumber,
            firstName: input.firstName,
        });
      }
      await this.handleSuccessfulLogin(ctx, newUser);
      return newUser;
    } catch (error: any) {
      // Lost a create race against a concurrent request: the unique index on
      // (strategy, externalIdentifier) rejected our insert. Re-fetch the
      // winner's user and return that instead of bubbling the duplicate error.
      if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) {
        const authRepo = this.connection.getRepository(ctx, ExternalAuthenticationMethod);
        const winner = await authRepo.findOne({
          where: { strategy: STRATEGY_PHONE_OTP, externalIdentifier: input.phoneNumber },
          relations: ['user'],
        });
        if (winner?.user) {
          const verifiedUser = await this.ensureUserVerified(ctx, winner.user);
          await this.syncChannelPermissions(ctx, verifiedUser.id);
          await this.handleSuccessfulLogin(ctx, verifiedUser);
          return verifiedUser;
        }
      }
      return Promise.reject(error);
    }
  }

  private async syncChannelPermissions(ctx: RequestContext, userId: ID) {
      const customer = await this.connection.getRepository(ctx, Customer).findOne({
          where: { user: { id: userId }, deletedAt: IsNull() },
          relations: ['channels'],
      });

      if (!customer) return;

      const preChannelIds = (customer.channels ?? []).map(c => c.id);
      console.log(`[PhoneOtpChannelTrace] customer=${customer.id} BEFORE assign channels=[${preChannelIds.join(',')}]`);

      const targetChannelIds = await resolveBrandChannelIds(ctx, this.channelService);

      if (targetChannelIds.length > 0) {
        await syncCustomerChannelsOnLogin(
          this.channelService,
          ctx,
          customer.id,
          targetChannelIds,
        );
      }
      const after = await this.connection.getRepository(ctx, Customer).findOne({
          where: { id: customer.id }, relations: ['channels'],
      });
      const postChannelIds = (after?.channels ?? []).map(c => c.id);
      console.log(`[PhoneOtpChannelTrace] customer=${customer.id} target=[${targetChannelIds.join(',')}] AFTER assign channels=[${postChannelIds.join(',')}]`);
  }

  private async ensureUserVerified(ctx: RequestContext, user: User): Promise<User> {
      if (!user.verified) {
          const userRepo = this.connection.getRepository(ctx, User);
          user.verified = true;
          await userRepo.save(user);
      }
      return user;
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
          console.log(`[PhoneOtpStrategy] Cancelling deletion request for customer ${customer.id} due to login`);
      }
  }
}

/**
 * Vendure requires an email on every account. WhatsApp and SMS logins do not
 * provide one, so the phone number stands in. The domain must be one the brand
 * owns: mail to these addresses must never reach a stranger's inbox.
 */
function buildPlaceholderEmail(phoneNumber: string): string {
  const domain = process.env.PLACEHOLDER_EMAIL_DOMAIN || DEFAULT_PLACEHOLDER_EMAIL_DOMAIN;
  return `${phoneNumber}@${domain}`;
}
