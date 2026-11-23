import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    EventBus,
    FulfillmentEvent,
    FulfillmentStateTransitionEvent,
    Logger,
    OrderService,
    OrderStateTransitionEvent,
    TransactionalConnection,
} from '@vendure/core';

import { ADLOGGS_FULFILLMENT_TYPE, loggerCtx } from '../constants';
import { AdloggsFulfillmentService } from './adloggs-fulfillment.service';

/**
 * Event wiring for Adloggs fulfillments (mirrors the Shiprocket Quick
 * subscriber):
 *
 * 1. Fulfillment created with fulfillmentType "adloggs" → create the delivery
 *    order at Adloggs. Runs post-commit so a slow/hung Adloggs call (observed
 *    on their dev environment) can never hold the fulfillment transaction open.
 * 2. Order cancelled → cancel all live Adloggs orders of that order.
 * 3. Individual fulfillment cancelled → cancel its Adloggs order. Skipped when
 *    the cancellation was caused BY an Adloggs webhook (adloggsStatus is
 *    already terminal by then, so no echo is sent back).
 */
@Injectable()
export class AdloggsFulfillmentSubscriber implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private adloggsFulfillmentService: AdloggsFulfillmentService,
        private connection: TransactionalConnection,
        private orderService: OrderService,
    ) {}

    async onApplicationBootstrap() {
        this.eventBus.ofType(FulfillmentEvent).subscribe(async event => {
            try {
                const ctx = event.ctx;
                const fulfillment = event.entity;
                const fulfillmentType = (fulfillment as any).customFields?.fulfillmentType;
                if (fulfillmentType !== ADLOGGS_FULFILLMENT_TYPE) {
                    return;
                }

                const fulfillmentWithLines = (await this.connection.getRepository(ctx, 'Fulfillment').findOne({
                    where: { id: fulfillment.id },
                    relations: ['lines', 'lines.orderLine', 'lines.orderLine.order'],
                })) as any;
                const orderId = fulfillmentWithLines?.lines?.[0]?.orderLine?.order?.id;
                if (!orderId) {
                    Logger.error(`Could not get order from fulfillment ${fulfillment.id}`, loggerCtx);
                    return;
                }

                const order = await this.orderService.findOne(ctx, orderId, [
                    'customer',
                    'lines',
                    'lines.productVariant',
                    'channels',
                    'payments',
                    'shippingLines',
                    'shippingLines.shippingMethod',
                ]);
                if (!order) {
                    Logger.error(`Could not load order ${orderId} for fulfillment ${fulfillment.id}`, loggerCtx);
                    return;
                }

                await this.adloggsFulfillmentService.createAdloggsOrderOnFulfillment(ctx, fulfillment, order);
            } catch (error: any) {
                Logger.error(`Error in Adloggs fulfillment subscriber: ${error.message}`, loggerCtx, error.stack);
            }
        });

        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async event => {
            try {
                if (event.toState !== 'Cancelled' || !event.order) {
                    return;
                }
                await this.adloggsFulfillmentService.cancelAdloggsOrdersForOrder(
                    event.ctx,
                    event.order.id,
                    `Order ${event.order.code} cancelled`,
                );
            } catch (error: any) {
                Logger.error(`Error in Adloggs order-cancel subscriber: ${error.message}`, loggerCtx, error.stack);
            }
        });

        this.eventBus.ofType(FulfillmentStateTransitionEvent).subscribe(async event => {
            try {
                if (event.toState !== 'Cancelled') {
                    return;
                }
                await this.adloggsFulfillmentService.cancelAdloggsForFulfillment(
                    event.ctx,
                    event.fulfillment,
                    'Fulfillment cancelled in KaaiKani admin',
                );
            } catch (error: any) {
                Logger.error(`Error in Adloggs fulfillment-cancel subscriber: ${error.message}`, loggerCtx, error.stack);
            }
        });
    }
}
