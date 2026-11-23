import { Fulfillment } from '@vendure/core';

/** Who is bringing an order, as its owner may see them. */
export interface OrderDeliveryPerson {
    name: string;
    phoneNumber: string | null;
    /** OTP the customer gives the rider. */
    deliveryOtp: string | null;
}

const clean = (value: unknown) => String(value ?? '').trim();

/**
 * Adloggs statuses from pickup until delivery: picked up (4), out for
 * delivery (9), arrived at the address (8). Picked up keeps the Vendure
 * fulfillment in Shipped; out for delivery moves it on. Delivered,
 * cancelled and the return flows are excluded: nobody is bringing the order
 * any more.
 */
const ADLOGGS_PICKED_UP_UNTIL_DELIVERED = [4, 9, 8];

/** Fulfillment states in which an Adloggs rider can have the order. */
const ADLOGGS_STATES = ['Shipped', 'OutforDelivery'];

/**
 * The Adloggs rider bringing the order, with the delivery OTP, from pickup
 * until delivery (most recently updated fulfillment first). Null before
 * pickup, after delivery, and for every other carrier.
 *
 * Our own fleet is deliberately left out: the customer is never given our
 * delivery staff's name or phone number.
 */
export function deliveryPersonOf(fulfillments: Fulfillment[]): OrderDeliveryPerson | null {
    const candidates = [...fulfillments].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    for (const fulfillment of candidates) {
        const fields = fulfillment.customFields as any;
        if (
            fields?.fulfillmentType !== 'adloggs' ||
            !ADLOGGS_STATES.includes(fulfillment.state as string) ||
            !ADLOGGS_PICKED_UP_UNTIL_DELIVERED.includes(Number(fields?.adloggsStatus))
        ) {
            continue;
        }
        const name = clean(fields?.adloggsRiderName);
        if (!name) continue;
        const phone = clean(fields?.adloggsRiderPhone);
        return {
            name,
            phoneNumber: phone || null,
            deliveryOtp: clean(fields?.adloggsDeliveryOtp) || null,
        };
    }
    return null;
}
