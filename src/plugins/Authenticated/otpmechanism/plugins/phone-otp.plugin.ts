// src/gaia/plugins/phone-otp.plugin.ts
import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { PhoneOtpAuthenticationStrategy } from '../strategies/phone-otp.strategy';
import { PhoneOtpService } from '../services/phone-otp.service';
import { SmsService } from '../../../../smsService';
import { PhoneOtpResolver } from '../resolver/phone-otp.resolver';
import gql from 'graphql-tag';
import { AuthenticationPhoneOtp } from '../entities/authentication-phone-otp.entity';
import { CurrentUserEntityResolver } from '../resolver/current-user-entity.resolver';
import { PhoneCustomerService } from '../../shared/phone-customer.service';

// Define schema extension for the mutation
const schemaExtension = gql`
  extend type Mutation {
    sendPhoneOtp(phoneNumber: String!): String
    resendPhoneOtp(phoneNumber: String!): String

    # Mutation to update the email and mark user as verified
    updateProfileEmail(email: String!): Customer

    # Verifies the OTP sent to the new phone number, then updates the
    # customer's phone number. Verification and update happen in one call
    # because a verified OTP is consumed and cannot be re-checked.
    updatePhoneNumber(phoneNumber: String!, code: String!): Customer
  }
  extend type CurrentUser {
    customerId: ID
  }
`;

@VendurePlugin({
  imports: [PluginCommonModule],
  compatibility: '^3.6.3',
  shopApiExtensions: {
    schema: schemaExtension,
    resolvers: [PhoneOtpResolver,CurrentUserEntityResolver],
  },
  providers: [
      PhoneOtpService,
      PhoneOtpResolver,
      SmsService,
      PhoneOtpAuthenticationStrategy,
      PhoneCustomerService,
  ],
  entities: [AuthenticationPhoneOtp],
})
export class PhoneOtpPlugin {}