import { OrderProcess } from '@vendure/core';

/**
 * Custom order process that adds an "OutforDelivery" state
 * after "Shipped" and before "Delivered".
 *
 * Order Flow: ... → PaymentSettled → Shipped → OutforDelivery → Delivered
 */
export const deliveryOrderProcess: OrderProcess<'OutforDelivery'> = {
    transitions: {
        Shipped: {
            to: ['OutforDelivery'],
            mergeStrategy: 'merge',
        },
        PartiallyShipped: {
            to: ['OutforDelivery'],
            mergeStrategy: 'merge',
        },
        OutforDelivery: {
            // PartiallyDelivered is the fallback when a multi-fulfillment order has
            // only some items delivered — see DeliveryFulfillmentStateSubscriber.
            // Cancelled allows aborting a delivery that is already out (failed
            // delivery, customer refusal). Actual cancellation must still go
            // through OrderService.cancelOrder so stock/refunds are handled.
            to: ['Delivered', 'PartiallyDelivered', 'Cancelled'],
        },
        PartiallyDelivered: {
            // Allow the next fulfillment of a partially-delivered order to go back
            // out for delivery. PartiallyDelivered → Delivered is inherited from
            // the default order process via merge.
            to: ['OutforDelivery'],
            mergeStrategy: 'merge',
        },
    },
};
