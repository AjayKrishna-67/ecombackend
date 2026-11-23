import { describe, expect, it } from 'vitest';

import {
    AdhocMapperInput,
    buildAdhocPayload,
    formatShiprocketDate,
    sanitizePhone,
    splitName,
    validateAdhocInput,
} from './order-payload.mapper';

const input = (over: Partial<AdhocMapperInput> = {}): AdhocMapperInput => ({
    orderCode: 'M-1002',
    orderDate: new Date(2026, 6, 4, 15, 35), // 2026-07-04 15:35 (local)
    currencyCode: 'USD',
    invoiceNumber: 'INV-1002',
    pickupLocationName: 'warehouse',
    fullName: 'Elena Petrova',
    streetLine1: '10 Anson Road',
    streetLine2: '#12-08 International Plaza',
    city: 'Singapore',
    state: 'Singapore',
    postalCode: '079903',
    countryName: 'Singapore',
    countryCode: 'SG',
    email: 'test@shiprocket.com',
    phone: '7466651885',
    items: [
        { name: 'Foxtail Millet sweet Balls', sku: '5-47606', units: 1, sellingPrice: 1.35, hsn: '21069099' },
        { name: 'Semolina sweet Balls', sku: '5-47607', units: 2, sellingPrice: 1.41, hsn: '17049090' },
    ],
    shippingChargesMajor: 19.62,
    length: 10,
    breadth: 10,
    height: 10,
    weightKg: 0.41,
    ...over,
});

describe('splitName', () => {
    it('splits first token vs remainder', () => {
        expect(splitName('Elena Petrova')).toEqual({ first: 'Elena', last: 'Petrova' });
        expect(splitName('Maria del Carmen')).toEqual({ first: 'Maria', last: 'del Carmen' });
        expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' });
        expect(splitName('   ')).toEqual({ first: '', last: '' });
    });
});

describe('sanitizePhone', () => {
    it('keeps local digits as-is', () => {
        expect(sanitizePhone('7466651885', 'SG')).toBe('7466651885');
    });
    it('strips formatting characters', () => {
        expect(sanitizePhone('+65 7466-651885', 'SG')).toBe('7466651885');
    });
    it('strips a leading country code the storefront may have prepended', () => {
        expect(sanitizePhone('+91 98765 43210', 'IN')).toBe('9876543210');
    });
    it('does not eat digits when stripping would leave too few', () => {
        // "651885" starts with '65' but only 4 digits would remain → keep as-is
        expect(sanitizePhone('651885', 'SG')).toBe('651885');
    });
});

describe('formatShiprocketDate', () => {
    it('formats as YYYY-MM-DD HH:mm with zero-padding', () => {
        expect(formatShiprocketDate(new Date(2026, 0, 5, 9, 3))).toBe('2026-01-05 09:03');
    });
});

describe('validateAdhocInput', () => {
    it('passes a complete order', () => {
        expect(validateAdhocInput(input())).toEqual([]);
    });
    it('flags an empty state (Shiprocket rejects blank billing_state)', () => {
        const problems = validateAdhocInput(input({ state: '' }));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/state/i);
    });

    it('flags empty phone, pincode, weight, pickup location', () => {
        const problems = validateAdhocInput(
            input({ phone: '', postalCode: '', weightKg: 0, pickupLocationName: '' }),
        );
        expect(problems).toHaveLength(4);
        expect(problems.join(' ')).toMatch(/phone/i);
        expect(problems.join(' ')).toMatch(/postal/i);
        expect(problems.join(' ')).toMatch(/weight/i);
        expect(problems.join(' ')).toMatch(/pickup/i);
    });
});

describe('buildAdhocPayload', () => {
    it('maps core fields and derives the ISD code from the country', () => {
        const p = buildAdhocPayload(input());
        expect(p.order_id).toBe('M-1002');
        expect(p.order_date).toBe('2026-07-04 15:35');
        expect(p.pickup_location).toBe('warehouse');
        expect(p.billing_customer_name).toBe('Elena');
        expect(p.billing_last_name).toBe('Petrova');
        expect(p.billing_isd_code).toBe('+65'); // Singapore, derived not hardcoded
        expect(p.billing_phone).toBe('7466651885');
        expect(p.shipping_is_billing).toBe(true);
        expect(p.currency).toBe('USD');
        expect(p.weight).toBe(0.41);
    });

    it('derives +91 for India and +1 for the US', () => {
        expect(buildAdhocPayload(input({ countryCode: 'IN' })).billing_isd_code).toBe('+91');
        expect(buildAdhocPayload(input({ countryCode: 'us' })).billing_isd_code).toBe('+1');
    });

    it('honours an ISD override and falls back to "" for unknown countries', () => {
        expect(buildAdhocPayload(input({ countryCode: 'ZZ' })).billing_isd_code).toBe('');
        expect(
            buildAdhocPayload(input({ countryCode: 'ZZ', isdOverrides: { ZZ: '+999' } })).billing_isd_code,
        ).toBe('+999');
    });

    it('sends the full address (door no + street) in billing_address; line 2 stays empty', () => {
        const p = buildAdhocPayload(input());
        expect(p.billing_address).toBe('10 Anson Road, #12-08 International Plaza');
        expect(p.billing_address_2).toBe('');
    });

    it('omits the separator when streetLine2 is empty', () => {
        const p = buildAdhocPayload(input({ streetLine2: '' }));
        expect(p.billing_address).toBe('10 Anson Road');
        expect(p.billing_address_2).toBe('');
    });

    it('computes sub_total from units × selling_price', () => {
        // 1×1.35 + 2×1.41 = 4.17
        expect(buildAdhocPayload(input()).sub_total).toBe(4.17);
    });

    it('maps line items with rounded selling_price', () => {
        const p = buildAdhocPayload(input());
        expect(p.order_items).toHaveLength(2);
        expect(p.order_items[1]).toEqual({
            name: 'Semolina sweet Balls',
            sku: '5-47607',
            units: 2,
            selling_price: 1.41,
            hsn: '17049090',
        });
    });
});
