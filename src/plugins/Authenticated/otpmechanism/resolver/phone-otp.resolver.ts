// phone-otp.resolver.ts
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    RequestContext,
    CustomerService,
    UserService,
    Permission,
    Customer,
    User,
    TransactionalConnection,
    UserInputError,
    InternalServerError,
    ExternalAuthenticationMethod,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { PhoneOtpService } from '../services/phone-otp.service';
import { STRATEGY_PHONE_OTP } from '../constants';

@Resolver()
export class PhoneOtpResolver {
  constructor(
      private phoneOtpService: PhoneOtpService,
      private customerService: CustomerService,
      private userService: UserService,
      private connection: TransactionalConnection
  ) {}

  @Mutation()
  sendPhoneOtp(@Ctx() ctx: RequestContext, @Args() args: { phoneNumber: string }): Promise<string | null> {
    return this.phoneOtpService.sendOtp(ctx, args.phoneNumber);
  }

  @Mutation()
  resendPhoneOtp(@Ctx() ctx: RequestContext, @Args() args: { phoneNumber: string }): Promise<string | null> {
    return this.phoneOtpService.resendOtp(ctx, args.phoneNumber);
  }

  @Mutation()
  @Allow(Permission.Owner) // Ensures only the logged-in user can update their own email
  async updateProfileEmail(
      @Ctx() ctx: RequestContext, 
      @Args() args: { email: string }
  ): Promise<Customer | undefined> {
      const userId = ctx.activeUserId;
      if (!userId) {
          throw new InternalServerError('No active user found');
      }

      // 1. Check if the new email is already taken by a DIFFERENT user
      const existingUser = await this.userService.getUserByEmailAddress(ctx, args.email);
      if (existingUser && existingUser.id !== userId) {
          throw new UserInputError('This email address is already in use by another account.');
      }

      // 2. Find the Customer associated with the current User
      const customer = await this.customerService.findOneByUserId(ctx, userId);

      if (!customer) {
          // Debugging: Check if this is an Admin user trying to use Shop API features
          const user = await this.userService.getUserById(ctx, userId);
          const isSuperAdmin = user?.roles.some(r => r.code === 'super-admin');

          if (isSuperAdmin) {
              throw new UserInputError('Administrators cannot use this mutation. Please log in as a Customer.');
          }

          throw new InternalServerError(`Customer profile not found for User ID ${userId}. You may not be assigned to the current channel (${ctx.channel.token}).`);
      }

      // 3. Update the Customer's email address
      await this.customerService.update(ctx, {
          id: customer.id,
          emailAddress: args.email
      });

      // 4. Update the User's verified status to TRUE
      // We access the User repository directly to flip the flag
      const userRepo = this.connection.getRepository(ctx, User);
      await userRepo.update(userId, { verified: true });

      // 5. Return the updated customer object
      return this.customerService.findOne(ctx, customer.id);
  }

  @Mutation()
  @Allow(Permission.Owner)
  async updatePhoneNumber(
      @Ctx() ctx: RequestContext,
      @Args() args: { phoneNumber: string; code: string }
  ): Promise<Customer | undefined> {
      const userId = ctx.activeUserId;
      if (!userId) {
          throw new InternalServerError('No active user found');
      }

      const customer = await this.customerService.findOneByUserId(ctx, userId);
      if (!customer) {
          throw new InternalServerError(
              `Customer profile not found for User ID ${userId}. You may not be assigned to the current channel (${ctx.channel.token}).`,
          );
      }

      // Check uniqueness before consuming the OTP, so a taken number does not
      // burn the code. The CustomerPhoneSubscriber enforces this again on save.
      const customerRepo = this.connection.getRepository(ctx, Customer);
      const existing = await customerRepo.findOne({
          where: { phoneNumber: args.phoneNumber, deletedAt: IsNull() },
      });
      if (existing && existing.id !== customer.id) {
          throw new UserInputError('This phone number is already registered with another account.');
      }

      const verified = await this.phoneOtpService.verifyOtp(ctx, args.phoneNumber, args.code);
      if (!verified) {
          throw new UserInputError('Invalid or expired OTP.');
      }

      await this.customerService.update(ctx, {
          id: customer.id,
          phoneNumber: args.phoneNumber,
      });

      // Keep the phone-OTP login identity in sync, so signing in with the new
      // number resolves to this user and the old number no longer does.
      const authRepo = this.connection.getRepository(ctx, ExternalAuthenticationMethod);
      const authMethod = await authRepo.findOne({
          where: { strategy: STRATEGY_PHONE_OTP, user: { id: userId } },
      });
      if (authMethod) {
          await authRepo.update(authMethod.id, { externalIdentifier: args.phoneNumber });
      }

      return this.customerService.findOne(ctx, customer.id);
  }
}