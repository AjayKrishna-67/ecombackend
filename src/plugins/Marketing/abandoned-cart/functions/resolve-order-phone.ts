import { Order } from '@vendure/core';

/**
 * First usable phone for an abandoned-cart nudge: customer phone, else the shipping address
 * phone, else the billing address phone. Empty strings are treated as missing. undefined if none.
 */
export function resolveOrderPhone(order: Order): string | undefined {
    return (
        order.customer?.phoneNumber ||
        order.shippingAddress?.phoneNumber ||
        order.billingAddress?.phoneNumber ||
        undefined
    );
}
