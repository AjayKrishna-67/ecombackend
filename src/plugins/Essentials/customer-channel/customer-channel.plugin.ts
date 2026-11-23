import {
    PluginCommonModule,
    VendurePlugin,
} from '@vendure/core';
import { shopApiExtensions } from './api/api-extensions';
import { CustomerChannelResolver } from './api/customer-channel.resolver';
import { CustomerChannelService } from './services/customer-channel.service';

/**
 * Customer Channel Plugin
 *
 * Provides queries to fetch channels/stores/brands based on:
 * 1. Customer email address
 * 2. Customer phone number
 * 3. Postal code availability
 *
 * ## Use Cases:
 *
 * ### Scenario 1: Store Switching for Registered Customers
 * - Customer clicks "Switch Stores" button
 * - Query `getChannelsByCustomerEmail()` to show all stores they have access to
 * - Customer selects a store and switches channel
 *
 * ### Scenario 2: Postal Code Based Channel Selection
 * - Customer enters postal code (or friend's postal code)
 * - Query `getChannelsByPostalCode()` to show available stores in that location
 * - Returns both location-based (CITY) channels and brand (BRAND) channels available there
 *
 * ### Scenario 3: Guest/Phone Lookup
 * - Guest customer identified by phone number
 * - Query `getChannelsByCustomerPhoneNumber()` to get their assigned channels
 * - Supports phone-based authentication/registration flows
 *
 * ## Integration with Channel Availability Plugin:
 *
 * This plugin can work alongside the ChannelAvailabilityPlugin which provides:
 * - Postal code → Channel availability with detailed messaging
 * - Channel type differentiation (CITY vs BRAND)
 * - Auto-fetch from saved address
 *
 * Use this plugin when you need:
 * - Simple channel lookup by customer identifier
 * - Raw channel tokens for switching
 *
 * Use ChannelAvailabilityPlugin when you need:
 * - Detailed availability status with messaging
 * - Channel type context for frontend routing
 * - Smart message handling for unavailable channels
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [CustomerChannelService],
    exports: [CustomerChannelService],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [CustomerChannelResolver],
    },
    compatibility: '^3.6.3',
})
export class CustomerChannelPlugin { }
