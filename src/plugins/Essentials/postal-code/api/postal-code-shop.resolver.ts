import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    RequestContext,
    CustomerService,
    OrderService,
    TransactionalConnection,
    EntityHydrator,
    Address,
    Order,
    UserInputError,
    CountryService,
} from '@vendure/core';
import { CreateAddressInput, UpdateAddressInput } from '@vendure/common/lib/generated-types';
import { PostalCodeService } from '../services/postal-code.service';

@Resolver()
export class PostalCodeShopResolver {
    constructor(
        private postalCodeService: PostalCodeService,
        private customerService: CustomerService,
        private orderService: OrderService,
        private connection: TransactionalConnection,
        private entityHydrator: EntityHydrator,
        private countryService: CountryService,
    ) {}

    @Query()
    async postalCodes(@Ctx() ctx: RequestContext) {
        const result = await this.postalCodeService.findAll(ctx);
        const anywhereConfig = result.items.find(pc => pc.isAnywhere === true);
        if (anywhereConfig) {
            return [];
        }
        return result.items
            .filter(pc => !pc.isAnywhere)
            .map(pc => ({
                id: pc.id,
                code: pc.code,
                isAnywhere: false,
                areas: (pc.areas || [])
                    .filter(a => a.enabled)
                    .map(a => ({ id: a.id, name: a.name, enabled: true })),
            }));
    }

    @Query()
    async areasForPostalCode(
        @Ctx() ctx: RequestContext,
        @Args('code') code: string,
    ): Promise<Array<{ id: any; name: string; enabled: boolean }>> {
        const result = await this.postalCodeService.findAll(ctx);
        const anywhereConfig = result.items.find(pc => pc.isAnywhere === true);
        if (anywhereConfig) {
            return [];
        }
        const postalCode = result.items.find(pc => pc.code === code && !pc.isAnywhere);
        if (!postalCode) {
            return [];
        }
        return (postalCode.areas || []).map(a => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
        }));
    }

    @Mutation()
    async createCustomerAddress(
        @Ctx() ctx: RequestContext,
        @Args('input') input: CreateAddressInput,
    ): Promise<Address> {
        const area = (input as any).customFields?.area;
        await this.postalCodeService.validatePostalCode(ctx, input.postalCode, area);
        if (!ctx.activeUserId) {
            throw new UserInputError('You must be logged in to create an address');
        }
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);
        if (!customer) {
            throw new UserInputError('Customer not found');
        }
        return this.customerService.createAddress(ctx, customer.id, input);
    }

    @Mutation()
    async updateCustomerAddress(
        @Ctx() ctx: RequestContext,
        @Args('input') input: UpdateAddressInput,
    ): Promise<Address> {
        const area = (input as any).customFields?.area;
        await this.postalCodeService.validatePostalCode(ctx, input.postalCode, area);
        return this.customerService.updateAddress(ctx, input);
    }

    /**
     * Override setOrderShippingAddress to work around Vendure 3.1 bug where
     * Order.discounts getter crashes during applyPriceAdjustments save.
     * This uses a direct QueryBuilder update (same as Vendure core lines 777-783)
     * then hydrates the order with lines before returning.
     */
    @Mutation()
    async setOrderShippingAddress(
        @Ctx() ctx: RequestContext,
        @Args('input') input: CreateAddressInput,
    ): Promise<Order | null> {
        const area = (input as any).customFields?.area;
        await this.postalCodeService.validatePostalCode(ctx, input.postalCode, area);
        const activeOrderId = ctx.session?.activeOrderId;
        if (!activeOrderId) {
            throw new UserInputError('No active order found');
        }
        // Load order with lines to prevent discounts getter crash
        const order = await this.orderService.findOne(ctx, activeOrderId, [
            'lines',
            'lines.productVariant',
            'lines.productVariant.productVariantPrices',
            'shippingLines',
            'surcharges',
            'customer',
        ]);
        if (!order) {
            throw new UserInputError('Active order not found');
        }
        // Build the shipping address object
        const country = await this.countryService.findOneByCode(ctx, input.countryCode);
        const shippingAddress = {
            ...input,
            countryCode: input.countryCode,
            country: country?.name || input.countryCode,
        };
        // Update via QueryBuilder (no Object.assign on Order, no discounts getter trigger)
        await this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('order')
            .update(Order)
            .set({ shippingAddress: shippingAddress as any })
            .where('id = :id', { id: order.id })
            .execute();
        order.shippingAddress = shippingAddress as any;
        // Return the order with lines hydrated
        await this.entityHydrator.hydrate(ctx, order, { relations: ['lines'] });
        return order;
    }
}
