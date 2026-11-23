import { FulfillmentProcess } from '@vendure/core';

/**
 * Custom fulfillment process that inserts an "OutforDelivery" state between
 * "Shipped" and "Delivered".
 *
 * Fulfillment flow: Pending → Shipped → OutforDelivery → Delivered
 *
 * NOTE: this process only defines the extra state + transitions. Coordinating
 * the ORDER state (→ OutforDelivery / Delivered / PartiallyDelivered) is done by
 * DeliveryFulfillmentStateSubscriber, which reacts to FulfillmentStateTransitionEvent
 * AFTER this fulfillment transaction commits.
 *
 * Why not do the order transition here in onTransitionEnd? Because onTransitionEnd
 * runs inside the fulfillment's transaction: if the order's "Delivered" guard
 * threw (e.g. the guard could not yet see the freshly-saved fulfillment state, or
 * the order was only partially delivered), the throw rolled the whole transaction
 * back — undoing the fulfillment's own Delivered transition and leaving delivery
 * permanently stuck. Handling it in the post-commit subscriber decouples the two:
 * the fulfillment delivery is durable on its own, and the order is transitioned to
 * whichever state its coverage actually supports.
 */
export const deliveryFulfillmentProcess: FulfillmentProcess<'OutforDelivery'> = {
    transitions: {
        Shipped: {
            to: ['OutforDelivery'],
            mergeStrategy: 'merge',
        },
        OutforDelivery: {
            to: ['Delivered'],
        },
    },
};
