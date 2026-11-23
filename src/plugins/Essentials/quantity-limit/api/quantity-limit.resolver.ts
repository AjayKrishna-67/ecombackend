import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    Order,
    RequestContext,
    Logger,
} from '@vendure/core';
import { QuantityLimitService } from '../services/quantity-limit.service';
import { QuantityLimitValidationStatus, StockAvailabilityResult } from '../types/quantity-limit-types';

const loggerCtx = 'QuantityLimitResolver';

/**
 * Resolver for Order.quantityLimitStatus field
 */
@Resolver('Order')
export class QuantityLimitOrderResolver {
    constructor(private quantityLimitService: QuantityLimitService) {}

    @ResolveField()
    async quantityLimitStatus(
        @Ctx() ctx: RequestContext,
        @Parent() order: Order
    ): Promise<QuantityLimitValidationStatus> {
        return this.quantityLimitService.validateOrder(ctx, order);
    }
}

/**
 * Resolver for Order.isAvailable and Order.unavailableReason fields.
 *
 * Both fields come from the same stock check. It is run once per Order and
 * shared: GraphQL resolves the two sibling fields concurrently, so the Promise
 * itself is what is kept, not the result -- otherwise both would miss and the
 * stock-level join would run twice for every cart read. Keyed weakly on the
 * Order object the response is built from, so it lives exactly as long as that
 * response does and never carries over to another request.
 */
@Resolver('Order')
export class StockAvailabilityOrderResolver {
    private stockAvailability = new WeakMap<Order, Promise<StockAvailabilityResult>>();

    constructor(private quantityLimitService: QuantityLimitService) {}

    private checkStockAvailability(ctx: RequestContext, order: Order): Promise<StockAvailabilityResult> {
        let result = this.stockAvailability.get(order);
        if (!result) {
            result = this.quantityLimitService.checkStockAvailability(ctx, order);
            this.stockAvailability.set(order, result);
        }
        return result;
    }

    @ResolveField()
    async isAvailable(
        @Ctx() ctx: RequestContext,
        @Parent() order: Order
    ): Promise<boolean> {
        if (order.active === false) {
            return true;
        }
        const result = await this.checkStockAvailability(ctx, order);
        return result.isAvailable;
    }

    @ResolveField()
    async unavailableReason(
        @Ctx() ctx: RequestContext,
        @Parent() order: Order
    ): Promise<string | null> {
        if (order.active === false) {
            return null;
        }
        Logger.debug(
            `Resolving stock availability for order ${order.code} with ${order.lines?.length || 0} lines`,
            loggerCtx
        );
        const result = await this.checkStockAvailability(ctx, order);
        return result.unavailableReason;
    }
}
