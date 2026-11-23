import { describe, expect, it } from 'vitest';

import { deliveryPersonOf } from './customer-delivery-person';

const adloggs = (adloggsStatus: number, extra: Record<string, unknown> = {}) => ({
    fulfillmentType: 'adloggs',
    adloggsStatus,
    adloggsRiderName: 'CHANCHAL ',
    adloggsRiderPhone: '8617639264',
    adloggsDeliveryOtp: '9243',
    ...extra,
});

const f = (state: string, customFields: Record<string, unknown>, updatedAt = '2026-10-16T10:00:00Z') =>
    ({ state, customFields, updatedAt: new Date(updatedAt) }) as any;

const ownFleet = {
    fulfillmentType: 'own-delivery-fleet',
    deliveryPersonId: '33',
    deliveryPersonName: 'Ajay Krishna',
    deliveryPersonPhone: '8903115165',
};

describe('deliveryPersonOf', () => {
    const rider = { name: 'CHANCHAL', phoneNumber: '8617639264', deliveryOtp: '9243' };

    it('gives the Adloggs rider and OTP from pickup until delivery', () => {
        // Picked up keeps the fulfillment Shipped; out for delivery and
        // arrived move it to OutforDelivery. The rider shows throughout.
        expect(deliveryPersonOf([f('Shipped', adloggs(4))])).toEqual(rider);
        expect(deliveryPersonOf([f('OutforDelivery', adloggs(9))])).toEqual(rider);
        expect(deliveryPersonOf([f('OutforDelivery', adloggs(8))])).toEqual(rider);
    });

    it('shows no Adloggs rider before pickup', () => {
        for (const status of [2, 3, 11]) {
            expect(deliveryPersonOf([f('Pending', adloggs(status))])).toBeNull();
            expect(deliveryPersonOf([f('Shipped', adloggs(status))])).toBeNull();
        }
    });

    it('drops the Adloggs rider once the delivery is over or coming back', () => {
        for (const status of [5, 6, 13, 14]) {
            expect(deliveryPersonOf([f('OutforDelivery', adloggs(status))])).toBeNull();
        }
    });

    it('never gives out our own delivery staff', () => {
        for (const state of ['Shipped', 'OutforDelivery', 'Delivered']) {
            expect(deliveryPersonOf([f(state, ownFleet)])).toBeNull();
        }
    });

    it('gives null phone and OTP when Adloggs sent none', () => {
        expect(
            deliveryPersonOf([f('Shipped', adloggs(4, { adloggsRiderPhone: '', adloggsDeliveryOtp: null }))]),
        ).toEqual({ name: 'CHANCHAL', phoneNumber: null, deliveryOtp: null });
    });

    it('is null without a rider name', () => {
        expect(deliveryPersonOf([f('Shipped', adloggs(4, { adloggsRiderName: '  ' }))])).toBeNull();
        expect(deliveryPersonOf([])).toBeNull();
    });

    it('takes the most recently updated fulfillment', () => {
        const older = f('Shipped', adloggs(4, { adloggsRiderName: 'Old' }), '2026-10-16T09:00:00Z');
        const newer = f('Shipped', adloggs(4, { adloggsRiderName: 'New' }), '2026-10-16T11:00:00Z');
        expect(deliveryPersonOf([older, newer])?.name).toBe('New');
    });
});
