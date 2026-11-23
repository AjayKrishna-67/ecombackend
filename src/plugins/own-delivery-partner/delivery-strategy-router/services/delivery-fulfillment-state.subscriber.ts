import { Injectable } from '@nestjs/common';
import {
    EventBus,
    FulfillmentStateTransitionEvent,
    isGraphQlErrorResult,
    Logger,
    OrderService,
    TransactionalConnection,
} from '@vendure/core';
import { DeliveryFulfillmentService } from './delivery-fulfillment.service';

const loggerCtx = 'DeliveryFulfillmentSubscriber';

/**
 * Listens for fulfillment state transitions and auto-coordinates fulfillment ↔ order states.
 *
 * 1. Pending → auto-ship for own-delivery-fleet and manual/take-away
 * 2. OutforDelivery → auto-transition order to OutforDelivery
 * 3. Delivered → auto-transition order to Delivered (with state bridging)
 */
@Injectable()
export class DeliveryFulfillmentStateSubscriber {
    constructor(
        private eventBus: EventBus,
        private deliveryFulfillmentService: DeliveryFulfillmentService,
        private connection: TransactionalConnection,
        private orderService: OrderService,
    ) {
        this.eventBus
            .ofType(FulfillmentStateTransitionEvent)
            .subscribe(async (event) => {
                await this.onFulfillmentStateTransition(event);
            });
    }

    private async onFulfillmentStateTransition(event: FulfillmentStateTransitionEvent) {
        const { fulfillment, ctx } = event;
        const toState = event.toState as string;

        // ── 1. Fulfillment just created (Pending) ──
        if (toState === 'Pending') {
            const fulfillmentType = (fulfillment as any).customFields?.fulfillmentType || 'own-delivery-fleet';

            // Shiprocket International fulfillments keep their own tracking code (AWB/shipment id)
            // and must stay Pending until the shipment is actually dispatched.
            if (fulfillmentType === 'shiprocket-international') {
                return;
            }

            // Set tracking code
            await this.connection
                .getRepository(ctx, 'Fulfillment')
                .createQueryBuilder()
                .update()
                .set({ trackingCode: `#${fulfillment.id}` })
                .where('id = :id', { id: fulfillment.id })
                .execute();

            // Auto-ship for own delivery fleet and take-away
            if (fulfillmentType === 'own-delivery-fleet' || fulfillmentType === 'manual') {
                const label = fulfillmentType === 'manual' ? 'Take Away' : 'Own Delivery Fleet';
                Logger.info(`Fulfillment ${fulfillment.id} [${label}]: auto-transitioning to "Shipped"`, loggerCtx);
                try {
                    await this.deliveryFulfillmentService.transitionFulfillmentToState(ctx, fulfillment.id, 'Shipped');
                } catch (e: any) {
                    Logger.error(`Failed to auto-ship fulfillment ${fulfillment.id}: ${e.message}`, loggerCtx);
                }
            }
            return;
        }

        // ── 2. Fulfillment → OutforDelivery: also transition order ──
        if (toState === 'OutforDelivery') {
            const orderId = await this.getOrderIdFromFulfillment(ctx, fulfillment.id);
            if (orderId) {
                try {
                    await this.orderService.transitionToState(ctx, orderId, 'OutforDelivery' as any);
                    Logger.info(`Order ${orderId} auto-transitioned to "OutforDelivery"`, loggerCtx);
                } catch (e: any) {
                    Logger.warn(`Could not transition order ${orderId} to OutforDelivery (may already be there): ${e.message}`, loggerCtx);
                }
            }
            return;
        }

        // ── 3. Fulfillment → Delivered: sync order state ──
        // Runs here (not in deliveryFulfillmentProcess.onTransitionEnd) on purpose.
        // Vendure's EventBus defers .ofType() delivery until the fulfillment
        // transaction COMMITS and hands us a detached ctx copy (transaction manager
        // stripped — see event-bus awaitActiveTransactions). So the fulfillment's
        // "Delivered" state is already committed and visible: no read-your-writes
        // race, and — critically — a guard failure here can NEVER roll back the
        // fulfillment delivery, because it is no longer in the same transaction.
        // Mirrors the OutforDelivery handler above.
        if (toState === 'Delivered') {
            const fulfillmentType = (fulfillment as any).customFields?.fulfillmentType;
            // Take-away (manual) fulfillments are never "delivered" to a customer,
            // so they must not auto-deliver the order.
            if (fulfillmentType === 'manual') {
                Logger.info(`Fulfillment ${fulfillment.id} [Take Away]: skipping order auto-deliver`, loggerCtx);
                return;
            }
            const orderId = await this.getOrderIdFromFulfillment(ctx, fulfillment.id);
            if (orderId) {
                await this.syncOrderDeliveredState(ctx, orderId);
            }
            return;
        }
    }

    /**
     * Transition the order to the state matching its fulfillment coverage.
     *
     * Tries "Delivered" first; if core's `orderItemsAreDelivered` guard rejects
     * it because only some items are delivered (multi-fulfillment orders), falls
     * back to "PartiallyDelivered". This reuses Vendure's own coverage guards
     * instead of reimplementing the math. Each transitionToState opens its own
     * transaction on the (already committed) fulfillment, so the guard reads the
     * fulfillment as Delivered reliably.
     *
     * Never throws: a partial order is a normal resting state, and the fulfillment
     * delivery has already committed — the subscriber must not crash the stream.
     */
    private async syncOrderDeliveredState(ctx: any, orderId: string): Promise<void> {
        try {
            const delivered = await this.orderService.transitionToState(ctx, orderId, 'Delivered' as any);
            if (!isGraphQlErrorResult(delivered)) {
                Logger.info(`Order ${orderId} auto-transitioned to "Delivered"`, loggerCtx);
                return;
            }
            const partial = await this.orderService.transitionToState(ctx, orderId, 'PartiallyDelivered' as any);
            if (!isGraphQlErrorResult(partial)) {
                Logger.info(`Order ${orderId} auto-transitioned to "PartiallyDelivered"`, loggerCtx);
                return;
            }
            Logger.warn(
                `Order ${orderId}: could not transition to Delivered or PartiallyDelivered — ${(partial as any).message}`,
                loggerCtx,
            );
        } catch (e: any) {
            Logger.error(`Order ${orderId}: delivery state sync failed — ${e.message}`, loggerCtx);
        }
    }

    /**
     * OPTIMIZED: Raw scalar query returning only the order ID.
     * Was: 4-join leftJoinAndSelect loading full entity graph for Fulfillment + Lines + OrderLine + Order.
     * Now: innerJoin + select('o.id') + limit(1) → returns a single scalar value.
     */
    private async getOrderIdFromFulfillment(ctx: any, fulfillmentId: any): Promise<string | null> {
        const row = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .select('o.id', 'orderId')
            .where('f.id = :id', { id: fulfillmentId })
            .limit(1)
            .getRawOne();
        return row?.orderId || null;
    }
}
