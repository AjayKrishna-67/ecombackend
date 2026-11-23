import { Args, Query, Resolver } from '@nestjs/graphql';
import { Ctx, OrderService, RequestContext } from '@vendure/core';

import { ShiprocketOrderService } from '../services/shiprocket-order.service';

@Resolver()
export class ShiprocketShopResolver {
    constructor(
        private orderService: OrderService,
        private shiprocketOrderService: ShiprocketOrderService,
    ) {}

    /**
     * Live Shiprocket tracking for one of the current customer's orders. Looks up the order's
     * fulfillment AWB, then proxies to Shiprocket so the token never reaches the storefront.
     * Returns `null` when the caller doesn't own the order or no AWB has been generated yet.
     */
    @Query()
    async shiprocketTracking(@Ctx() ctx: RequestContext, @Args('orderCode') orderCode: string) {
        const order = await this.orderService.findOneByCode(ctx, orderCode, ['customer', 'customer.user']);
        if (!order) {
            return null;
        }
        // Only the authenticated owner may read tracking (guests can use Shiprocket's track_url).
        if (!ctx.activeUserId || order.customer?.user?.id !== ctx.activeUserId) {
            return null;
        }
        // Ignore cancelled fulfillments (cancel + re-fulfil creates a fresh Shiprocket order) and
        // prefer the newest AWB, so tracking always follows the live shipment.
        const fulfillments = (await this.orderService.getOrderFulfillments(ctx, order)).filter(
            f => f.state !== 'Cancelled',
        );
        const awb = fulfillments
            .map(f => (f.customFields as any)?.shiprocketAwb as string | undefined)
            .reverse()
            .find(a => !!a);
        if (!awb) {
            return null;
        }
        return (await this.shiprocketOrderService.trackByAwb(awb)) ?? null;
    }
}
