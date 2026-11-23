import { Injectable } from '@nestjs/common';
import {
  AuthenticationStrategy,
  Injector,
  RequestContext,
  User,
} from '@vendure/core';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';
import { STRATEGY_PHONE_OTP } from '../constants';
import { PhoneOtpService } from '../services/phone-otp.service';
import { PhoneCustomerService } from '../../shared/phone-customer.service';

export type PhoneAuthData = {
  phoneNumber: string;
  code: string;
  firstName: string;
  lastName: string;
  emailAddress?: string;
};

@Injectable()
export class PhoneOtpAuthenticationStrategy implements AuthenticationStrategy {
  readonly name = STRATEGY_PHONE_OTP;
  private service: PhoneOtpService;
  private phoneCustomerService: PhoneCustomerService;

  constructor() { }

  init(injector: Injector) {
    this.service = injector.get(PhoneOtpService);
    this.phoneCustomerService = injector.get(PhoneCustomerService);
  }

  defineInputType(): DocumentNode {
    return gql`
      input PhoneOtpInput {
        phoneNumber: String!
        code: String!
        firstName: String
        lastName: String
        emailAddress: String
      }
    `;
  }

  async authenticate(ctx: RequestContext, data: PhoneAuthData): Promise<User | false | string> {
    const verified = await this.service.verifyOtp(ctx, data.phoneNumber, data.code);
    if (!verified) return "Invalid OTP";
    return this.phoneCustomerService.findOrCreateUser(ctx, {
      phoneNumber: data.phoneNumber,
      firstName: data.firstName,
      lastName: data.lastName,
      emailAddress: data.emailAddress,
    });
  }
}
