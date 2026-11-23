/**
 * Row mapping for the fleet detail page's "assigned orders" list
 * (`driverAssignedOrders`). Kept pure so it can be unit-tested without a
 * database — the query itself lives in DeliveryTrackingService.
 */

/** Fulfillment states in which an assignment is still with the rider. */
export const OPEN_FULFILLMENT_STATES = ['Created', 'Pending', 'Shipped', 'OutforDelivery'];

export interface DriverAssignedOrder {
    fulfillmentId: string;
    orderId: string;
    orderCode: string;
    state: string;
    assignedAt: Date;
    deliveredAt: Date | null;
    customerName: string | null;
    area: string | null;
    /** Order total incl. shipping, in paise. */
    orderTotal: number;
}

function parseAddress(value: unknown): Record<string, any> {
    if (value && typeof value === 'object') {
        return value as Record<string, any>;
    }
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

/**
 * Raw rows arrive one per fulfillment LINE (the order code needs the
 * line → order join), so collapse them to one per fulfillment, newest first.
 */
export function toDriverAssignedOrders(rows: any[]): DriverAssignedOrder[] {
    const byFulfillment = new Map<string, DriverAssignedOrder>();
    for (const row of rows) {
        const fulfillmentId = String(row.fulfillmentId);
        if (byFulfillment.has(fulfillmentId)) {
            continue;
        }
        const address = parseAddress(row.shippingAddress);
        const customer = `${row.customerFirstName || ''} ${row.customerLastName || ''}`.trim();
        byFulfillment.set(fulfillmentId, {
            fulfillmentId,
            orderId: String(row.orderId),
            orderCode: row.orderCode,
            state: row.state,
            assignedAt: new Date(row.assignedAt),
            // No stamp ⇒ delivered from the Vendure admin UI; updatedAt is the
            // same fallback the report's bootstrap backfill uses.
            deliveredAt:
                row.state === 'Delivered' && (row.deliveredAt || row.updatedAt)
                    ? new Date(row.deliveredAt || row.updatedAt)
                    : null,
            customerName: address.fullName || customer || null,
            area: address.customFields?.area || address.city || null,
            orderTotal: (Number(row.subTotalWithTax) || 0) + (Number(row.shippingWithTax) || 0),
        });
    }
    // Same-second assignments (bulk assign) tie on createdAt — the later id wins
    return [...byFulfillment.values()].sort(
        (a, b) =>
            b.assignedAt.getTime() - a.assignedAt.getTime() || Number(b.fulfillmentId) - Number(a.fulfillmentId),
    );
}
