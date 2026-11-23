import { Address, Logger, Order, RequestContext, TransactionalConnection } from '@vendure/core';

/**
 * Coordinates of the delivery point, plus where they came from.
 *
 * `recovered` is true when the order's own shipping address carried no pin and
 * the coordinates had to be read back off one of the customer's saved
 * addresses — the normal case for admin-created draft orders, where Vendure's
 * admin UI copies the address onto the order WITHOUT its custom fields
 * (`mapToAddressInput` / `SelectAddressDialogComponent.select()` both list the
 * standard fields explicitly and omit `customFields`).
 */
export interface DeliveryCoords {
    lat: number;
    long: number;
    recovered: boolean;
}

export interface SavedPin {
    streetLine1: string;
    postalCode: string;
    latitude: number;
    longitude: number;
}

const norm = (value?: string | null) => (value ?? '').trim().toLowerCase();

/**
 * Picks the saved address whose pin best describes `target`: an exact
 * street + pincode match first, then any address on the same pincode, then
 * whatever pin the customer has. Kept pure so the ranking is testable without
 * a database.
 */
export function pickBestPin(
    target: { streetLine1?: string | null; postalCode?: string | null },
    candidates: SavedPin[],
): SavedPin | undefined {
    const street = norm(target.streetLine1);
    const postalCode = norm(target.postalCode);
    return (
        candidates.find(c => norm(c.streetLine1) === street && norm(c.postalCode) === postalCode) ??
        candidates.find(c => norm(c.postalCode) === postalCode) ??
        candidates[0]
    );
}

/**
 * Delivery coordinates for an order: the pin on the order's shipping address
 * when it has one, otherwise the best match from the customer's saved
 * addresses. Returns null when the customer has no pinned address at all.
 */
export async function resolveDeliveryCoords(
    ctx: RequestContext,
    order: Order,
    connection: TransactionalConnection,
    loggerCtx: string,
): Promise<DeliveryCoords | null> {
    const orderPin = order.shippingAddress?.customFields as any;
    if (orderPin?.latitude && orderPin?.longitude) {
        return { lat: Number(orderPin.latitude), long: Number(orderPin.longitude), recovered: false };
    }

    const customerId =
        order.customer?.id ??
        (
            await connection.getRepository(ctx, Order).findOne({
                where: { id: order.id },
                relations: { customer: true },
            })
        )?.customer?.id;
    if (!customerId) {
        return null;
    }

    const addresses = await connection
        .getRepository(ctx, Address)
        .find({ where: { customer: { id: customerId } } });

    const pinned: SavedPin[] = addresses
        .map(address => {
            const cf = address.customFields as any;
            return {
                streetLine1: address.streetLine1,
                postalCode: address.postalCode,
                latitude: Number(cf?.latitude),
                longitude: Number(cf?.longitude),
            };
        })
        .filter(pin => Number.isFinite(pin.latitude) && Number.isFinite(pin.longitude) && (pin.latitude || pin.longitude));

    const best = pickBestPin(order.shippingAddress ?? {}, pinned);
    if (!best) {
        return null;
    }
    Logger.info(
        `Recovered delivery pin (${best.latitude}, ${best.longitude}) from saved address for order ${order.code}`,
        loggerCtx,
    );
    return { lat: best.latitude, long: best.longitude, recovered: true };
}
