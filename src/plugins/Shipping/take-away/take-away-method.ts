import { Order, RequestContext, ShippingLine, ShippingMethod, TransactionalConnection } from '@vendure/core';

/**
 * A method counts as Take Away (store pickup) when it uses the take-away
 * calculator AND its store is pinned, so switching a method to another
 * calculator cleanly disables take-away behaviour even if old pin values
 * remain stored.
 */
export function isPickupMethod(method: ShippingMethod | null | undefined): boolean {
    const cf = method?.customFields as any;
    return (
        method?.calculator?.code === 'take-away-calculator' &&
        cf?.storeLatitude != null &&
        cf?.storeLongitude != null
    );
}

/**
 * The pickup methods on the order's shipping lines.
 *
 * Orders reach here loaded to different depths: the order process and the
 * snapshot get lines with their method, `OrderService.findOne` gives lines
 * with only the method id, and the active-order strategy used by custom-field
 * validation loads no lines at all. Each gap is filled here, so callers never
 * have to know which one they were handed.
 */
export async function findPickupMethods(
    ctx: RequestContext,
    connection: TransactionalConnection,
    order: Order,
): Promise<ShippingMethod[]> {
    const lines =
        order.shippingLines ??
        (await connection.getRepository(ctx, ShippingLine).find({
            where: { order: { id: order.id } },
            relations: ['shippingMethod'],
        }));
    const methods: ShippingMethod[] = [];
    for (const line of lines) {
        const method =
            line.shippingMethod ??
            (line.shippingMethodId
                ? await connection.getRepository(ctx, ShippingMethod).findOne({ where: { id: line.shippingMethodId } })
                : null);
        if (isPickupMethod(method)) {
            methods.push(method!);
        }
    }
    return methods;
}
