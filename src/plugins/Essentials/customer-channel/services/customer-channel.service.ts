import { Injectable } from '@nestjs/common';
import {
    CacheService,
    Logger,
    RequestContext,
    TransactionalConnection,
    CustomerService,
    UserService,
} from '@vendure/core';
import { Channel, Customer } from '@vendure/core';
import { IsNull } from 'typeorm';
import { PostalCode } from '../../postal-code/entities/postal-code.entity';

const loggerCtx = 'CustomerChannelService';

const CUSTOMER_CHANNEL_TTL_MS = 5 * 60 * 1000;        // 5 minutes for customer-keyed lookups
const POSTAL_CHANNEL_TTL_MS = 15 * 60 * 1000;         // 15 minutes for postal-keyed lookup
const CUSTOMER_CHANNEL_TAG = 'customer-channel:all';
const POSTAL_TAG_ALL = 'postal-codes:all';
const emailKey = (email: string) => `customer-channel:email:${email.toLowerCase()}`;
const phoneKey = (phone: string) => `customer-channel:phone:${phone}`;
const postalKey = (postalCode: string) => `customer-channel:postal:${postalCode}`;

/**
 * CustomerChannelService
 *
 * Handles fetching available channels for customers based on:
 * 1. Customer email address
 * 2. Customer phone number
 * 3. Postal code availability
 */
@Injectable()
export class CustomerChannelService {
    constructor(
        private connection: TransactionalConnection,
        private customerService: CustomerService,
        private userService: UserService,
        private cacheService: CacheService,
    ) { }

    /**
     * Get channels by customer email address
     *
     * @param ctx Request context
     * @param email Customer email
     * @returns Array of channels assigned to the customer
     */
    async getChannelsByCustomerEmail(
        ctx: RequestContext,
        email: string
    ): Promise<Channel[]> {
        try {
            const cacheKey = emailKey(email);
            const cached = (await this.cacheService.get(cacheKey)) as Channel[] | undefined;
            if (cached) {
                return cached;
            }

            // Find user by email
            const user = await this.userService.getUserByEmailAddress(ctx, email, 'customer');
            if (!user) {
                throw new Error(`User not found with email: ${email}`);
            }

            // Get customer from user
            const customer = await this.customerService.findOneByUserId(ctx, user.id, false);
            if (!customer) {
                throw new Error(`Customer not found for user: ${email}`);
            }

            // Load customer with channels
            const customerWithChannels = await this.customerService.findOne(ctx, customer.id, ['channels']);
            if (!customerWithChannels?.channels) {
                return [];
            }

            const result = this.filterDefaultChannel(customerWithChannels.channels);
            await this.cacheService.set(cacheKey, result as any, {
                ttl: CUSTOMER_CHANNEL_TTL_MS,
                tags: [CUSTOMER_CHANNEL_TAG],
            });
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get channels by email: ${errorMessage}`);
        }
    }

    /**
     * Get channels by customer phone number
     *
     * @param ctx Request context
     * @param phoneNumber Customer phone number
     * @returns Array of channels assigned to the customer
     */
    async getChannelsByCustomerPhoneNumber(
        ctx: RequestContext,
        phoneNumber: string
    ): Promise<Channel[]> {
        try {
            const cacheKey = phoneKey(phoneNumber);
            const cached = (await this.cacheService.get(cacheKey)) as Channel[] | undefined;
            if (cached) {
                return cached;
            }

            // Query customer by phone number
            const customer = await this.connection.getRepository(ctx, Customer).findOne({
                where: {
                    phoneNumber,
                    deletedAt: IsNull(), // Only non-deleted customers
                },
                relations: ['channels'],
            });

            if (!customer) {
                throw new Error(`Customer is not registered`);
            }

            const result = this.filterDefaultChannel(customer.channels || []);
            await this.cacheService.set(cacheKey, result as any, {
                ttl: CUSTOMER_CHANNEL_TTL_MS,
                tags: [CUSTOMER_CHANNEL_TAG],
            });
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get channels by phone: ${errorMessage}`);
        }
    }

    /**
     * Get channels by postal code
     *
     * Returns all channels that:
     * 1. Have the specific postal code assigned
     * 2. Are set to "Anywhere" mode (isAnywhere: true)
     *
     * @param ctx Request context
     * @param postalCode Postal code to query
     * @returns Array of available channels for the postal code
     */
    async getChannelsByPostalCode(
        ctx: RequestContext,
        postalCode: string
    ): Promise<Channel[]> {
        try {
            const cacheKey = postalKey(postalCode);
            const cached = (await this.cacheService.get(cacheKey)) as Channel[] | undefined;
            if (cached) {
                return cached;
            }

            // Find PostalCode entries: exact match OR anywhere mode
            const postalCodeEntries = await this.connection
                .getRepository(ctx, PostalCode)
                .find({
                    where: [
                        { code: postalCode },    // Exact postal code match
                        { isAnywhere: true }     // Or any "Anywhere" postal code rule
                    ],
                    relations: ['channels'],
                });

            if (!postalCodeEntries || postalCodeEntries.length === 0) {
                return [];
            }

            // Deduplicate channels using Map
            const uniqueChannels = new Map<string, Channel>();

            for (const entry of postalCodeEntries) {
                if (entry.channels && entry.channels.length > 0) {
                    for (const channel of entry.channels) {
                        // Skip default channel
                        if (channel.code === '__default_channel__') {
                            continue;
                        }
                        // Skip disabled channels (enabled defaults to true if not set)
                        const isEnabled = ((channel.customFields as any)?.enabled ?? true) as boolean;
                        if (!isEnabled) {
                            continue;
                        }
                        uniqueChannels.set(channel.id.toString(), channel);
                    }
                }
            }

            const result = Array.from(uniqueChannels.values());
            await this.cacheService.set(cacheKey, result as any, {
                ttl: POSTAL_CHANNEL_TTL_MS,
                tags: [CUSTOMER_CHANNEL_TAG, POSTAL_TAG_ALL],
            });
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to get channels by postal code: ${errorMessage}`);
        }
    }

    /**
     * Invalidate customer-channel cache.
     * Call when a customer's channel assignments change.
     */
    async invalidateCache(): Promise<void> {
        await this.cacheService.invalidateTags([CUSTOMER_CHANNEL_TAG]);
        Logger.debug('[CustomerChannelService] Cache cleared', loggerCtx);
    }

    /**
     * Helper: Filter out the default channel
     *
     * @param channels Array of channels to filter
     * @returns Filtered array without default channel
     */
    private filterDefaultChannel(channels: Channel[]): Channel[] {
        return (channels || []).filter(
            channel => channel.code !== '__default_channel__'
        );
    }

}
