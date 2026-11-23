// phone-number-unique-validator.plugin.ts
import { VendurePlugin, PluginCommonModule } from '@vendure/core';
import { CustomerPhoneSubscriber } from './subscribers/customer-phone.subscriber';

/**
 * Plugin that enforces unique phone numbers across all customer accounts.
 *
 * Uses a TypeORM Entity Subscriber to intercept ALL customer updates
 * (including the built-in updateCustomer mutation) and validates
 * phone number uniqueness before the update is committed.
 *
 * Error message: "This phone number is already registered with another account."
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    providers: [CustomerPhoneSubscriber],
})
export class PhoneNumberUniqueValidatorPlugin {}
