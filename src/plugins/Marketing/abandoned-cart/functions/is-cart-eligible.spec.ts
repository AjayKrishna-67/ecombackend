import { describe, expect, it } from 'vitest';
import { isCartEligible } from './is-cart-eligible';

const base = { state: 'AddingItems', phoneNumber: '919999999999', totalWithTax: 50000, minOrderValueMinor: 30000 };

describe('isCartEligible', () => {
    it('accepts an active cart above min value with a phone', () => {
        expect(isCartEligible(base)).toBe(true);
    });
    it('rejects a non-AddingItems order', () => {
        expect(isCartEligible({ ...base, state: 'PaymentSettled' })).toBe(false);
    });
    it('rejects when no phone number', () => {
        expect(isCartEligible({ ...base, phoneNumber: null })).toBe(false);
    });
    it('rejects at or below min value (strictly greater required)', () => {
        expect(isCartEligible({ ...base, totalWithTax: 30000 })).toBe(false);
    });
    it('rejects when min value is null (hard guard, no sends)', () => {
        expect(isCartEligible({ ...base, minOrderValueMinor: null })).toBe(false);
    });
});
