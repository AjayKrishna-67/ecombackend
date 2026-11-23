import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    EventBus,
    Logger,
    Order,
    OrderPlacedEvent,
    OrderService,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { loggerCtx } from './constants';
import { pickupSlotOf } from './pickup-slot';
import { findPickupMethods } from './take-away-method';

/**
 * When a Take Away order is placed, copies the store location and pickup
 * window from the shipping method's custom fields onto the order itself.
 * Order history then reads them from the order — immutable — so later edits
 * to the shipping method (store moves, new hours) never rewrite old orders.
 */
@Injectable()
export class TakeAwayOrderSnapshotService implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private orderService: OrderService,
        private connection: TransactionalConnection,
    ) {}

    onApplicationBootstrap() {
        this.eventBus.ofType(OrderPlacedEvent).subscribe(event => {
            this.snapshotIfTakeAway(event.ctx, event.order).catch(err => {
                Logger.error(
                    `Failed to snapshot take-away store location for order ${event.order.code}: ${err.message}`,
                    loggerCtx,
                    err.stack,
                );
            });
        });
    }

    /**
     * Safe to call more than once: it rewrites the same values. WhatsappOrderService
     * calls it too, so the pickup pin it sends never races this subscriber.
     */
    async snapshotIfTakeAway(ctx: RequestContext, order: Order): Promise<void> {
        const [method] = await findPickupMethods(ctx, this.connection, order);
        if (!method) {
            return;
        }
        const store = (method.customFields ?? {}) as any;
        await this.orderService.updateCustomFields(ctx, order.id, {
            isTakeAway: true,
            pickupAddress: store.storeAddress ?? null,
            pickupLatitude: store.storeLatitude ?? null,
            pickupLongitude: store.storeLongitude ?? null,
            pickupMapUrl: store.storeMapUrl ?? null,
            pickupSlot: pickupSlotOf(method),
        });
        Logger.verbose(`Stored take-away pickup location on order ${order.code}`, loggerCtx);
    }
}
