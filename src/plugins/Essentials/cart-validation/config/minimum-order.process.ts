import { OrderProcess } from '@vendure/core';

import { minimumOrderOf, minimumOrderStatus } from '../services/minimum-order';

/**
 * Refuses checkout (AddingItems → ArrangingPayment) while the cart's product
 * total is below the channel's minimum order value. The message is returned
 * to the storefront as the transition error; carts show the same message
 * beforehand through `Order.validationStatus.minimumOrderMessage`.
 *
 * Only the customer's own move to payment is checked: admin draft orders
 * (Draft → ArrangingPayment) and later states are left alone.
 */
export const minimumOrderProcess: OrderProcess<never> = {
    onTransitionStart(fromState, toState, data) {
        if (fromState !== 'AddingItems' || toState !== 'ArrangingPayment') {
            return;
        }
        const { ctx, order } = data;
        const status = minimumOrderStatus(order.subTotalWithTax ?? 0, minimumOrderOf(ctx.channel));
        if (!status.meetsMinimumOrder) {
            return status.minimumOrderMessage ?? 'Minimum order value not reached';
        }
    },
};
