import { Query, Resolver } from '@nestjs/graphql';
import { Ctx, Order, RequestContext, OrderService } from '@vendure/core';
import { PriceUpdateService } from '../price-update.plugin';
import { Logger } from '@vendure/core';

const loggerCtx = 'PriceUpdateShopResolver';

/**
 * Shop API Resolver for Price Update Plugin
 * 
 * Extends the activeOrder query to automatically update prices
 * when customers access their cart.
 */
@Resolver()
export class PriceUpdateShopResolver {
    constructor(
        private orderService: OrderService,
        private priceUpdateService: PriceUpdateService,
    ) {}

    /**
     * Extended activeOrder query that automatically updates prices
     * for active users when they access their cart
     */
    @Query()
    async activeOrder(@Ctx() ctx: RequestContext): Promise<Order | null> {
        // Get the active order using OrderService method
        // This matches how Vendure core handles activeOrder
        const order = await (this.orderService as any).getActiveOrderForUser(ctx, ctx.activeUserId);
        
        if (!order || !order.active) {
            return null;
        }

        Logger.debug(
            `[Shop API] Checking price updates for order ${order.code}`,
            loggerCtx
        );

        // Trigger lazy price update for active user
        // This will update prices immediately if there are any changes
        const updatedOrder = await this.priceUpdateService.updatePricesForActiveOrder(
            ctx,
            order.id
        );

        if (updatedOrder && updatedOrder !== order) {
            Logger.info(
                `[Shop API] Prices updated for order ${order.code}`,
                loggerCtx
            );
        }

        return updatedOrder || order;
    }
}

