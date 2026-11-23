import { ActiveOrderService, Injector, RequestContext, TransactionalConnection } from '@vendure/core';

import {
    isWithinPickupSlot,
    PICKUP_TIME_OUTSIDE_ERROR,
    PickupSlot,
    pickupSlotOf,
    validatePickupTime,
} from './pickup-slot';
import { findPickupMethods } from './take-away-method';

export const PICKUP_TIME_NO_METHOD_ERROR = 'Select the Take Away shipping method before choosing a pickup time';

/**
 * Custom-field validator for the order's `pickupTime`. Runs inside Vendure's
 * custom-field validation of `setOrderCustomFields`, before the resolver.
 *
 * A customer's time must fall within the pickup hours of the pickup method
 * on their active order. An admin editing the order page is only held to the
 * time format, so staff can record a time agreed by phone.
 */
export async function validateOrderPickupTime(
    value: unknown,
    injector: Injector,
    ctx: RequestContext,
): Promise<string | undefined> {
    if (value == null || value === '') {
        return undefined;
    }
    const formatError = validatePickupTime(value);
    if (formatError) {
        return formatError;
    }
    if (ctx.apiType !== 'shop') {
        return undefined;
    }
    const order = await injector.get(ActiveOrderService).getActiveOrder(ctx, undefined);
    const methods = order ? await findPickupMethods(ctx, injector.get(TransactionalConnection), order) : [];
    if (!methods.length) {
        return PICKUP_TIME_NO_METHOD_ERROR;
    }
    const hours = methods.map(pickupSlotOf).filter((slot): slot is PickupSlot => slot !== null);
    if (!hours.length) {
        // A pickup method without hours asks for no time; accept what was sent.
        return undefined;
    }
    return hours.some(slot => isWithinPickupSlot(value, slot)) ? undefined : PICKUP_TIME_OUTSIDE_ERROR;
}
