import { describe, expect, it } from 'vitest';
import { resolveBodyVars } from './resolve-body-vars';
import { BodyVar } from '../types';

// Minimal order-like shape; resolveBodyVars only reads these fields.
const order: any = {
    code: 'ORD-123',
    totalWithTax: 45000,
    customer: { firstName: 'Asha', lastName: 'Rao' },
};

describe('resolveBodyVars', () => {
    it('maps tokens and static text to ordered body_{n} slots', () => {
        const mapping: BodyVar[] = [
            { kind: 'token', value: '{firstName}' },
            { kind: 'static', value: 'your cart' },
            { kind: 'token', value: '{cartTotal}' },
            { kind: 'token', value: '{orderCode}' },
        ];
        expect(resolveBodyVars(order, mapping)).toEqual({
            body_1: { type: 'text', value: 'Asha' },
            body_2: { type: 'text', value: 'your cart' },
            body_3: { type: 'text', value: '₹450.00' },
            body_4: { type: 'text', value: 'ORD-123' },
        });
    });
    it('resolves {customerName} as full name', () => {
        expect(resolveBodyVars(order, [{ kind: 'token', value: '{customerName}' }])).toEqual({
            body_1: { type: 'text', value: 'Asha Rao' },
        });
    });
    it('emits empty string for an unknown token', () => {
        expect(resolveBodyVars(order, [{ kind: 'token', value: '{nope}' }])).toEqual({
            body_1: { type: 'text', value: '' },
        });
    });
});
