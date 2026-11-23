import {
    OrderInterceptor,
    RequestContext,
    Order,
    Injector,
    Logger,
} from '@vendure/core';
import { PriceUpdateService } from '../price-update.plugin';

const loggerCtx = 'PriceUpdateInterceptor';

/**
 * OrderInterceptor that updates prices when orders are accessed
 * 
 * This intercepts order operations and ensures prices are up-to-date
 * before the order is returned to the customer.
 */
export class PriceUpdateInterceptor implements OrderInterceptor {
    private priceUpdateService: PriceUpdateService;

    init(injector: Injector) {
        this.priceUpdateService = injector.get(PriceUpdateService);
    }

    /**
     * Called when an order is accessed/retrieved
     * Updates prices if there are any changes (lazy update)
     */
    async onRead(ctx: RequestContext, order: Order): Promise<Order> {
        if (!order || !order.active) {
            return order;
        }

        try {
            // Update prices for active order (lazy update)
            const updatedOrder = await this.priceUpdateService.updatePricesForActiveOrder(
                ctx,
                order.id
            );

            if (updatedOrder && updatedOrder !== order) {
                Logger.debug(
                    `[Interceptor] Updated prices for order ${order.code}`,
                    loggerCtx
                );
            }

            return updatedOrder || order;
        } catch (error: any) {
            // If update fails, return original order
            // Log error but don't break the flow
            Logger.warn(
                `[Interceptor] Failed to update prices for order ${order.code}: ${error.message}`,
                loggerCtx
            );
            return order;
        }
    }
}

