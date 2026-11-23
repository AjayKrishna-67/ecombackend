import { Injector, OrderProcess, TransactionalConnection } from '@vendure/core';

import { isWithinPickupSlot, PickupSlot, pickupSlotOf } from './pickup-slot';
import { findPickupMethods } from './take-away-method';

export const PICKUP_TIME_REQUIRED_ERROR = 'Please choose a pickup time for your Take Away order';
export const PICKUP_TIME_STALE_ERROR = "The chosen pickup time is outside the store's pickup hours. Please choose another";

let connection: TransactionalConnection;

/**
 * Stops checkout at the move to payment when the selected pickup method has
 * pickup hours and the order has no chosen time, or a time outside those
 * hours. The message is returned to the storefront as the transition error.
 *
 * Checked here rather than only in the field validator because the customer
 * may select the method and never pick a time, and because the admin can
 * change the hours while a cart is open.
 */
export const takeAwayPickupTimeProcess: OrderProcess<never> = {
    init(injector: Injector) {
        connection = injector.get(TransactionalConnection);
    },
    async onTransitionStart(fromState, toState, data) {
        if (toState !== 'ArrangingPayment') {
            return;
        }
        const { ctx, order } = data;
        const methods = await findPickupMethods(ctx, connection, order);
        const hours = methods.map(pickupSlotOf).filter((slot): slot is PickupSlot => slot !== null);
        if (!hours.length) {
            return;
        }
        const chosen = order.customFields?.pickupTime;
        if (!chosen) {
            return PICKUP_TIME_REQUIRED_ERROR;
        }
        if (!hours.some(slot => isWithinPickupSlot(chosen, slot))) {
            return PICKUP_TIME_STALE_ERROR;
        }
    },
};
