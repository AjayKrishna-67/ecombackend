import { describe, expect, it } from 'vitest';

import { pickBestPin, resolveDeliveryCoords, SavedPin } from './resolve-delivery-coords';

const pin = (over: Partial<SavedPin> = {}): SavedPin => ({
    streetLine1: '1-B roja kudil',
    postalCode: '625001',
    latitude: 9.930242,
    longitude: 78.117353,
    ...over,
});

/**
 * Stands in for TransactionalConnection. `addresses` is what the address
 * repository returns; the Order repository is only consulted when the order
 * arrives without an eagerly-loaded customer.
 */
const fakeConnection = (addresses: Array<Record<string, any>>, customerId?: string) =>
    ({
        getRepository: (_ctx: any, entity: any) =>
            entity?.name === 'Order'
                ? { findOne: async () => (customerId ? { customer: { id: customerId } } : undefined) }
                : { find: async () => addresses },
    }) as any;

const order = (over: Record<string, any> = {}) =>
    ({
        id: 64221,
        code: 'TUQQ9BUV5Q4YN7NX',
        shippingAddress: { streetLine1: 'Kaaikani', postalCode: '625001' },
        customer: { id: '10457' },
        ...over,
    }) as any;

const address = (over: Record<string, any> = {}) => ({
    streetLine1: 'Kaaikani',
    postalCode: '625001',
    customFields: { latitude: 9.915706, longitude: 78.119382 },
    ...over,
});

describe('pickBestPin', () => {
    it('prefers an exact street + pincode match over a same-pincode one', () => {
        const exact = pin({ streetLine1: 'Kaaikani', latitude: 1, longitude: 1 });
        const samePincode = pin({ streetLine1: 'somewhere else', latitude: 2, longitude: 2 });
        expect(pickBestPin({ streetLine1: 'Kaaikani', postalCode: '625001' }, [samePincode, exact])).toBe(exact);
    });

    it('ignores case and surrounding whitespace when matching', () => {
        const saved = pin({ streetLine1: 'Kaaikani ' });
        expect(pickBestPin({ streetLine1: '  kaaikani', postalCode: '625001' }, [saved])).toBe(saved);
    });

    it('falls back to the same pincode when no street matches', () => {
        const samePincode = pin({ streetLine1: 'different street' });
        expect(pickBestPin({ streetLine1: 'Kaaikani', postalCode: '625001' }, [samePincode])).toBe(samePincode);
    });

    it('falls back to any pin when nothing matches', () => {
        const elsewhere = pin({ streetLine1: 'other', postalCode: '600017' });
        expect(pickBestPin({ streetLine1: 'Kaaikani', postalCode: '625001' }, [elsewhere])).toBe(elsewhere);
    });

    it('returns undefined when the customer has no pinned address', () => {
        expect(pickBestPin({ streetLine1: 'Kaaikani', postalCode: '625001' }, [])).toBeUndefined();
    });
});

describe('resolveDeliveryCoords', () => {
    const ctx = {} as any;

    it('uses the pin on the order and does not touch the database', async () => {
        const connection = fakeConnection([]);
        const result = await resolveDeliveryCoords(
            ctx,
            order({ shippingAddress: { streetLine1: 'Kaaikani', postalCode: '625001', customFields: { latitude: 9.1, longitude: 78.2 } } }),
            connection,
            'test',
        );
        expect(result).toEqual({ lat: 9.1, long: 78.2, recovered: false });
    });

    it('recovers the pin from the saved address when the order has none', async () => {
        const result = await resolveDeliveryCoords(ctx, order(), fakeConnection([address()]), 'test');
        expect(result).toEqual({ lat: 9.915706, long: 78.119382, recovered: true });
    });

    it('looks the customer up when the order has no loaded customer', async () => {
        const result = await resolveDeliveryCoords(
            ctx,
            order({ customer: undefined }),
            fakeConnection([address()], '10457'),
            'test',
        );
        expect(result?.recovered).toBe(true);
    });

    it('returns null when no saved address carries a pin', async () => {
        const unpinned = address({ customFields: { latitude: null, longitude: null } });
        expect(await resolveDeliveryCoords(ctx, order(), fakeConnection([unpinned]), 'test')).toBeNull();
    });

    it('returns null when the order has no customer at all', async () => {
        const result = await resolveDeliveryCoords(
            ctx,
            order({ customer: undefined }),
            fakeConnection([address()]),
            'test',
        );
        expect(result).toBeNull();
    });
});
