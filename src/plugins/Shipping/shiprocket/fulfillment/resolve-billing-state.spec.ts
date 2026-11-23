import { describe, expect, it } from 'vitest';

import { resolveBillingState } from './resolve-billing-state';

describe('resolveBillingState', () => {
    it('uses the order province when the address has one', () => {
        expect(resolveBillingState('Tamilnadu', 'Kerala')).toEqual({ state: 'Tamilnadu', fromPickup: false });
    });

    it('falls back to the pickup state when the province is an empty string', () => {
        expect(resolveBillingState('', 'Tamil Nadu')).toEqual({ state: 'Tamil Nadu', fromPickup: true });
    });

    it('falls back when the province is only whitespace', () => {
        expect(resolveBillingState('   ', 'Tamil Nadu')).toEqual({ state: 'Tamil Nadu', fromPickup: true });
    });

    it('falls back when the province is null or undefined', () => {
        expect(resolveBillingState(null, 'Tamil Nadu')?.fromPickup).toBe(true);
        expect(resolveBillingState(undefined, 'Tamil Nadu')?.fromPickup).toBe(true);
    });

    it('trims surrounding whitespace off the value it returns', () => {
        expect(resolveBillingState(' Tamilnadu ', null)).toEqual({ state: 'Tamilnadu', fromPickup: false });
    });

    it('returns null when neither the order nor the pickup location has a state', () => {
        expect(resolveBillingState('', '')).toBeNull();
        expect(resolveBillingState(null, undefined)).toBeNull();
    });
});
