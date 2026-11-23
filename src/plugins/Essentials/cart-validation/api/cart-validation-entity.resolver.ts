import { Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { Ctx, RequestContext, Order, OrderLine, Logger } from '@vendure/core';
import { CartValidationService } from '../services/cart-validation.service';
import { CartValidationStatus } from '../types/validation-types';
import { AvailabilityVariantDataLoader } from './availability-variant.dataloader';

const loggerCtx = 'CartValidationResolver';

/**
 * Resolver for Order entity - adds validationStatus field
 */
@Resolver('Order')
export class CartValidationOrderResolver {
    constructor(private cartValidationService: CartValidationService) {}

    @ResolveField()
    async validationStatus(
        @Ctx() ctx: RequestContext,
        @Parent() order: Order
    ): Promise<CartValidationStatus> {
        // Only validate active orders
        if (!order.active) {
            return {
                isValid: true,
                hasUnavailableItems: false,
                totalUnavailableItems: 0,
                unavailableItems: [],
                meetsMinimumOrder: true,
                minimumOrderAmount: null,
                amountToMinimumOrder: 0,
                minimumOrderMessage: null,
            };
        }

        Logger.debug(
            `Resolving validationStatus for order ${order.code} with ${order.lines?.length || 0} lines`,
            loggerCtx
        );

        // Log sample line data to debug
        if (order.lines && order.lines.length > 0) {
            const firstLine = order.lines[0];
            Logger.debug(
                `Sample line data - Variant name: ${firstLine.productVariant?.name}, Has product?: ${!!firstLine.productVariant?.product}`,
                loggerCtx
            );
        }

        return this.cartValidationService.validateOrder(ctx, order);
    }
}

/**
 * Resolver for OrderLine entity - adds isAvailable and unavailableReason fields.
 * Both fields read the line's variant through the request-scoped loader, so a
 * whole cart costs one variant query no matter how many lines or fields.
 */
@Resolver('OrderLine')
export class CartValidationLineResolver {
    constructor(
        private cartValidationService: CartValidationService,
        private availabilityVariantDataLoader: AvailabilityVariantDataLoader,
    ) {}

    private async availability(ctx: RequestContext, orderLine: OrderLine) {
        const variant = await this.availabilityVariantDataLoader
            .getLoader(ctx)
            .load(orderLine.productVariantId);
        return this.cartValidationService.lineAvailability(ctx, orderLine, variant);
    }

    @ResolveField()
    async isAvailable(
        @Ctx() ctx: RequestContext,
        @Parent() orderLine: OrderLine
    ): Promise<boolean> {
        return (await this.availability(ctx, orderLine)).isAvailable;
    }

    @ResolveField()
    async unavailableReason(
        @Ctx() ctx: RequestContext,
        @Parent() orderLine: OrderLine
    ): Promise<string | null> {
        return (await this.availability(ctx, orderLine)).reason;
    }
}
