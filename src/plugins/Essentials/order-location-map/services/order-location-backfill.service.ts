import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    Address,
    EventBus,
    Logger,
    Order,
    OrderPlacedEvent,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

const loggerCtx = 'OrderLocationMapPlugin';

/**
 * Safety net for storefronts that set the order shipping address without
 * passing the latitude/longitude custom fields: when an order is placed and
 * its shipping address has no coordinates, copy them from the customer's
 * saved address with the same street line. Storefronts should still pass
 * `customFields: { latitude, longitude }` to setOrderShippingAddress —
 * that is the only way guest orders (no saved addresses) get a pin.
 */
@Injectable()
export class OrderLocationBackfillService implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
    ) {}

    onApplicationBootstrap() {
        this.eventBus.ofType(OrderPlacedEvent).subscribe(event => {
            this.backfillCoordinates(event.ctx, event.order).catch((err: any) =>
                Logger.error(
                    `Failed to backfill pin location for order ${event.order.code}: ${err?.message ?? err}`,
                    loggerCtx,
                ),
            );
        });
    }

    private async backfillCoordinates(ctx: RequestContext, order: Order) {
        const existing = (order.shippingAddress as any)?.customFields ?? {};
        if (existing.latitude != null && existing.longitude != null) {
            return;
        }
        const orderWithCustomer = await this.connection.getRepository(ctx, Order).findOne({
            where: { id: order.id },
            relations: { customer: true },
        });
        const customerId = orderWithCustomer?.customer?.id;
        if (!customerId) {
            return;
        }
        const addresses = await this.connection.getRepository(ctx, Address).find({
            where: { customer: { id: customerId } },
        });
        const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
        const hasCoords = (a: Address) => {
            const cf = (a.customFields as any) ?? {};
            return cf.latitude != null && cf.longitude != null;
        };
        const streetMatches = addresses
            .filter(hasCoords)
            .filter(a => norm(a.streetLine1) === norm(order.shippingAddress?.streetLine1));
        // A single street match is unambiguous; with several, require the postal code to agree.
        const match =
            streetMatches.length === 1
                ? streetMatches[0]
                : streetMatches.find(a => norm(a.postalCode) === norm(order.shippingAddress?.postalCode));
        if (!match) {
            return;
        }
        const cf = match.customFields as any;
        const shippingAddress = {
            ...order.shippingAddress,
            customFields: { ...existing, latitude: cf.latitude, longitude: cf.longitude },
        };
        await this.connection
            .getRepository(ctx, Order)
            .update(order.id, { shippingAddress: shippingAddress as any });
        Logger.verbose(
            `Backfilled pin location for order ${order.code} from customer address ${match.id}`,
            loggerCtx,
        );
    }
}
