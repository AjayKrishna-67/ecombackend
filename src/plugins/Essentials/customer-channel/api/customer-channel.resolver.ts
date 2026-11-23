import {
    Resolver,
    Query,
    Args,
} from '@nestjs/graphql';
import { Ctx, RequestContext } from '@vendure/core';
import { CustomerChannelService } from '../services/customer-channel.service';

/**
 * GraphQL Resolver for Customer Channel queries
 *
 * Handles three main queries:
 * 1. getChannelsByCustomerEmail - Find channels by customer email
 * 2. getChannelsByCustomerPhoneNumber - Find channels by customer phone
 * 3. getChannelsByPostalCode - Find channels by postal code
 */
@Resolver()
export class CustomerChannelResolver {
    constructor(private customerChannelService: CustomerChannelService) { }

    /**
     * Query: getChannelsByCustomerEmail
     *
     * Retrieves all channels assigned to a customer by their email address.
     * Useful for showing all stores/brands a registered customer has access to.
     *
     * @param ctx Request context
     * @param email Customer email address
     * @returns Array of channels with token for store switching
     */
    @Query()
    async getChannelsByCustomerEmail(
        @Ctx() ctx: RequestContext,
        @Args() args: { email: string }
    ) {
        const channels = await this.customerChannelService.getChannelsByCustomerEmail(
            ctx,
            args.email
        );

        // Map to match GraphQL response type
        return channels.map(channel => ({
            id: channel.id,
            code: channel.code,
            token: channel.token,
            name: channel.code,
            type: ((channel.customFields as any)?.type || 'BRAND') as string,
        }));
    }

    /**
     * Query: getChannelsByCustomerPhoneNumber
     *
     * Retrieves all channels assigned to a customer by their phone number.
     * Useful for guest checkout or phone-based customer lookups.
     *
     * @param ctx Request context
     * @param phoneNumber Customer phone number
     * @returns Array of channels with token for store switching
     */
    @Query()
    async getChannelsByCustomerPhoneNumber(
        @Ctx() ctx: RequestContext,
        @Args() args: { phoneNumber: string }
    ) {
        const channels = await this.customerChannelService.getChannelsByCustomerPhoneNumber(
            ctx,
            args.phoneNumber
        );

        // Map to match GraphQL response type
        return channels.map(channel => ({
            id: channel.id,
            code: channel.code,
            token: channel.token,
            name: channel.code,
            type: ((channel.customFields as any)?.type || 'BRAND') as string,
        }));
    }

    /**
     * Query: getChannelsByPostalCode
     *
     * Retrieves all channels available for a specific postal code.
     * Returns both:
     * - Channels with this postal code explicitly assigned
     * - Channels with "Anywhere" mode enabled
     *
     * Useful for:
     * - Showing available stores when customer enters postal code
     * - Suggesting brands available in friend's location (Scenario 2)
     * - Location-based channel filtering
     *
     * @param ctx Request context
     * @param postalCode Postal code to query
     * @returns Array of available channels with token
     */
    @Query()
    async getChannelsByPostalCode(
        @Ctx() ctx: RequestContext,
        @Args() args: { postalCode: string }
    ) {
        const channels = await this.customerChannelService.getChannelsByPostalCode(
            ctx,
            args.postalCode
        );

        // Map to match GraphQL response type
        return channels.map(channel => ({
            id: channel.id,
            code: channel.code,
            token: channel.token,
            name: channel.code,
            type: ((channel.customFields as any)?.type || 'BRAND') as string,
        }));
    }

}
