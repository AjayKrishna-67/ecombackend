import { describe, expect, it } from 'vitest';

import { formatRupees, minimumOrderOf, minimumOrderStatus } from './minimum-order';

describe('minimumOrderOf', () => {
    it('reads the channel minimum in paise', () => {
        expect(minimumOrderOf({ customFields: { minimumOrderAmount: 29900 } })).toBe(29900);
    });

    it('is 0 when the channel has none', () => {
        expect(minimumOrderOf({ customFields: { minimumOrderAmount: null } })).toBe(0);
        expect(minimumOrderOf({ customFields: {} })).toBe(0);
        expect(minimumOrderOf({})).toBe(0);
        expect(minimumOrderOf(undefined)).toBe(0);
        expect(minimumOrderOf({ customFields: { minimumOrderAmount: -5 } })).toBe(0);
    });
});

describe('formatRupees', () => {
    it('drops paise when there are none', () => {
        expect(formatRupees(29900)).toBe('₹299');
        expect(formatRupees(100000)).toBe('₹1,000');
    });

    it('keeps paise when there are some', () => {
        expect(formatRupees(4950)).toBe('₹49.50');
    });
});

describe('minimumOrderStatus', () => {
    it('meets any total when the channel has no minimum', () => {
        expect(minimumOrderStatus(0, 0)).toEqual({
            meetsMinimumOrder: true,
            minimumOrderAmount: null,
            amountToMinimumOrder: 0,
            minimumOrderMessage: null,
        });
    });

    it('asks for the missing amount below the minimum', () => {
        expect(minimumOrderStatus(25000, 29900)).toEqual({
            meetsMinimumOrder: false,
            minimumOrderAmount: 29900,
            amountToMinimumOrder: 4900,
            minimumOrderMessage: 'Add products worth ₹49 more to checkout. Minimum order value is ₹299.',
        });
    });

    it('is met exactly at the minimum and above it', () => {
        expect(minimumOrderStatus(29900, 29900).meetsMinimumOrder).toBe(true);
        expect(minimumOrderStatus(29900, 29900).amountToMinimumOrder).toBe(0);
        expect(minimumOrderStatus(29900, 29900).minimumOrderMessage).toBeNull();
        expect(minimumOrderStatus(50000, 29900).meetsMinimumOrder).toBe(true);
    });

    it('treats an empty cart as below the minimum', () => {
        expect(minimumOrderStatus(0, 29900)).toMatchObject({ meetsMinimumOrder: false, amountToMinimumOrder: 29900 });
    });
});
