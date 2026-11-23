import { describe, expect, it } from 'vitest';

import { toDriverAssignedOrders } from './driver-assigned-orders';

/** One raw row per FULFILLMENT LINE, as the joined query returns them. */
function row(over: Record<string, unknown> = {}) {
    return {
        fulfillmentId: 7,
        state: 'Shipped',
        assignedAt: '2026-10-28T04:30:00.000Z',
        deliveredAt: null,
        orderId: 42,
        orderCode: 'KK-42',
        subTotalWithTax: 45000,
        shippingWithTax: 3000,
        shippingAddress: JSON.stringify({
            fullName: 'Priya',
            city: 'Madurai',
            customFields: { area: 'Anna Nagar' },
        }),
        customerFirstName: 'Priya',
        customerLastName: 'K',
        ...over,
    };
}

describe('toDriverAssignedOrders', () => {
    it('collapses the per-line rows of one fulfillment into one assignment', () => {
        const out = toDriverAssignedOrders([row(), row(), row()]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({
            fulfillmentId: '7',
            orderId: '42',
            orderCode: 'KK-42',
            state: 'Shipped',
            customerName: 'Priya',
            area: 'Anna Nagar',
            orderTotal: 48000,
            deliveredAt: null,
        });
        expect(out[0].assignedAt).toEqual(new Date('2026-10-28T04:30:00.000Z'));
    });

    it('keeps deliveredAt only for Delivered assignments', () => {
        const out = toDriverAssignedOrders([
            row({ fulfillmentId: 1, state: 'Delivered', deliveredAt: '2026-10-28T06:00:00.000Z' }),
            // A stale stamp on a non-delivered row must not read as a delivery
            row({ fulfillmentId: 2, state: 'Cancelled', deliveredAt: '2026-10-28T05:00:00.000Z' }),
        ]);
        const delivered = out.find(o => o.fulfillmentId === '1')!;
        const cancelled = out.find(o => o.fulfillmentId === '2')!;
        expect(delivered.deliveredAt).toEqual(new Date('2026-10-28T06:00:00.000Z'));
        expect(cancelled.deliveredAt).toBeNull();
    });

    it('uses updatedAt for a delivery marked from the Vendure admin UI (no stamp)', () => {
        const [a] = toDriverAssignedOrders([
            row({ state: 'Delivered', deliveredAt: null, updatedAt: '2026-10-28T07:15:00.000Z' }),
        ]);
        expect(a.deliveredAt).toEqual(new Date('2026-10-28T07:15:00.000Z'));
    });

    it('falls back to the customer name and city when the address lacks them', () => {
        const [a] = toDriverAssignedOrders([
            row({ shippingAddress: JSON.stringify({ fullName: '', city: 'Salem' }) }),
        ]);
        expect(a.customerName).toBe('Priya K');
        expect(a.area).toBe('Salem');
    });

    it('survives an unparseable or missing shipping address', () => {
        const out = toDriverAssignedOrders([
            row({ fulfillmentId: 1, shippingAddress: '{not json', customerFirstName: null, customerLastName: null }),
            row({ fulfillmentId: 2, shippingAddress: null }),
        ]);
        const a = out.find(o => o.fulfillmentId === '1')!;
        const b = out.find(o => o.fulfillmentId === '2')!;
        expect(a.customerName).toBeNull();
        expect(a.area).toBeNull();
        expect(b.customerName).toBe('Priya K');
    });

    it('accepts an already-parsed address object', () => {
        const [a] = toDriverAssignedOrders([row({ shippingAddress: { fullName: 'Ravi', city: 'Chennai' } })]);
        expect(a.customerName).toBe('Ravi');
        expect(a.area).toBe('Chennai');
    });

    it('orders assignments newest first', () => {
        const out = toDriverAssignedOrders([
            row({ fulfillmentId: 1, assignedAt: '2026-10-28T03:00:00.000Z' }),
            row({ fulfillmentId: 2, assignedAt: '2026-10-28T09:00:00.000Z' }),
            row({ fulfillmentId: 3, assignedAt: '2026-10-28T06:00:00.000Z' }),
        ]);
        expect(out.map(o => o.fulfillmentId)).toEqual(['2', '3', '1']);
    });

    it('breaks a same-second tie by the later fulfillment', () => {
        const out = toDriverAssignedOrders([
            row({ fulfillmentId: 9 }),
            row({ fulfillmentId: 10 }),
            row({ fulfillmentId: 8 }),
        ]);
        expect(out.map(o => o.fulfillmentId)).toEqual(['10', '9', '8']);
    });
});
