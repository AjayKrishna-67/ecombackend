import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    EventBus,
    FulfillmentEvent,
    FulfillmentStateTransitionEvent,
    OrderStateTransitionEvent,
    Logger,
    TransactionalConnection,
    OrderService,
} from '@vendure/core';
import { ShiprocketQuickFulfillmentService } from './shiprocket-quick-fulfillment.service';
import { ShipRocket } from '../services/ship-rocket';
import { loggerCtx } from '../constants';

@Injectable()
export class ShiprocketQuickFulfillmentSubscriber implements OnApplicationBootstrap {
    constructor(
        private eventBus: EventBus,
        private fulfillmentService: ShiprocketQuickFulfillmentService,
        private shipRocket: ShipRocket,
        private connection: TransactionalConnection,
        private orderService: OrderService,
    ) {}

    async onApplicationBootstrap() {
        // Subscribe to fulfillment creation events
        this.eventBus.ofType(FulfillmentEvent).subscribe(async event => {
            try {
                const ctx = event.ctx;
                const fulfillment = event.entity;

                // Only process fulfillments with shiprocket-quick fulfillment type
                const fulfillmentType = (fulfillment as any).customFields?.fulfillmentType;
                if (fulfillmentType !== 'shiprocket-quick') {
                    return;
                }

                // Load fulfillment with lines and orderLines to get the order:
                // Fulfillment -> FulfillmentLine -> OrderLine -> Order
                const fulfillmentWithLines = await this.connection.getRepository(ctx, 'Fulfillment').findOne({
                    where: { id: fulfillment.id },
                    relations: ['lines', 'lines.orderLine', 'lines.orderLine.order'],
                });

                if (!fulfillmentWithLines?.lines || fulfillmentWithLines.lines.length === 0) {
                    Logger.error(`Fulfillment ${fulfillment.id} has no lines`, loggerCtx);
                    return;
                }

                const firstFulfillmentLine = fulfillmentWithLines.lines[0];
                const orderLine = firstFulfillmentLine.orderLine;

                if (!orderLine?.order) {
                    Logger.error(`Could not get order from fulfillment ${fulfillment.id}`, loggerCtx);
                    return;
                }

                const order = await this.orderService.findOne(ctx, orderLine.order.id, [
                    'customer',
                    'lines',
                    'lines.productVariant',
                    'shippingLines',
                    'shippingLines.shippingMethod',
                ]);

                if (!order) {
                    Logger.error(`Could not load order ${orderLine.order.id} for fulfillment ${fulfillment.id}`, loggerCtx);
                    return;
                }

                await this.fulfillmentService.createQuickOrderOnFulfillment(ctx, fulfillment, order);
            } catch (error: any) {
                Logger.error(
                    `Error in Shiprocket Quick fulfillment subscriber: ${error.message}`,
                    loggerCtx,
                    error.stack,
                );
            }
        });

        // Subscribe to order cancellation events
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async event => {
            try {
                if (event.toState === 'Cancelled' && event.order) {
                    const ctx = event.ctx;
                    const order = event.order;

                    Logger.info(
                        `Order ${order.code} is being cancelled, checking for Shiprocket Quick orders to cancel`,
                        loggerCtx,
                    );

                    const fullOrder = await this.orderService.findOne(ctx, order.id, ['fulfillments']);
                    if (!fullOrder) {
                        Logger.warn(`Could not load order ${order.id} for cancellation`, loggerCtx);
                        return;
                    }

                    await this.fulfillmentService.cancelQuickOrderOnCancellation(ctx, fullOrder);
                }
            } catch (error: any) {
                Logger.error(
                    `Error in Shiprocket Quick cancellation subscriber: ${error.message}`,
                    loggerCtx,
                    error.stack,
                );
            }
        });

        // Subscribe to fulfillment state transitions for individual fulfillment cancellation
        this.eventBus.ofType(FulfillmentStateTransitionEvent).subscribe(async event => {
            try {
                if (event.toState !== 'Cancelled') {
                    return;
                }
                const fulfillment = event.fulfillment;
                const customFields = (fulfillment as any).customFields;
                if (customFields?.fulfillmentType !== 'shiprocket-quick') {
                    return;
                }
                const shiprocketOrderId = Number(customFields?.shiprocketOrderId);
                if (!shiprocketOrderId || isNaN(shiprocketOrderId)) {
                    Logger.info(
                        `Fulfillment ${fulfillment.id} cancelled but no Shiprocket order ID found`,
                        loggerCtx,
                    );
                    return;
                }
                Logger.info(
                    `Fulfillment ${fulfillment.id} cancelled, cancelling Shiprocket order ${shiprocketOrderId}`,
                    loggerCtx,
                );
                const cancelled = await this.shipRocket.cancelQuickOrder([shiprocketOrderId]);
                if (cancelled) {
                    Logger.info(`Successfully cancelled Shiprocket order ${shiprocketOrderId}`, loggerCtx);
                } else {
                    Logger.warn(`Failed to cancel Shiprocket order ${shiprocketOrderId}`, loggerCtx);
                }
            } catch (error: any) {
                Logger.error(
                    `Error in fulfillment cancellation subscriber: ${error.message}`,
                    loggerCtx,
                    error.stack,
                );
            }
        });
    }
}
