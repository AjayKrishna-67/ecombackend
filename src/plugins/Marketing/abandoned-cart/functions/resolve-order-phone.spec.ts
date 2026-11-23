import { describe, expect, it } from 'vitest';
import { resolveOrderPhone } from './resolve-order-phone';

describe('resolveOrderPhone', () => {
    it('prefers the customer phone', () => {
        const order: any = { customer: { phoneNumber: '91111' }, shippingAddress: { phoneNumber: '92222' }, billingAddress: { phoneNumber: '93333' } };
        expect(resolveOrderPhone(order)).toBe('91111');
    });
    it('falls back to shipping address phone when customer phone is missing', () => {
        const order: any = { customer: { phoneNumber: null }, shippingAddress: { phoneNumber: '92222' }, billingAddress: { phoneNumber: '93333' } };
        expect(resolveOrderPhone(order)).toBe('92222');
    });
    it('falls back to billing address phone when customer + shipping are missing', () => {
        const order: any = { customer: {}, shippingAddress: {}, billingAddress: { phoneNumber: '93333' } };
        expect(resolveOrderPhone(order)).toBe('93333');
    });
    it('treats empty string as missing and continues the chain', () => {
        const order: any = { customer: { phoneNumber: '' }, shippingAddress: { phoneNumber: '' }, billingAddress: { phoneNumber: '93333' } };
        expect(resolveOrderPhone(order)).toBe('93333');
    });
    it('returns undefined when no phone anywhere', () => {
        const order: any = { customer: { phoneNumber: null }, shippingAddress: {}, billingAddress: {} };
        expect(resolveOrderPhone(order)).toBeUndefined();
    });
});
