import { describe, expect, it } from 'vitest';

import {
    argsToRecord,
    buildAdloggsCreatePayload,
    generateDeliveryOtp,
    formatPickupDateTime,
    isStaleStatus,
    nearestPickup,
    normalizePhone,
    paiseToRupeeString,
    pickupConfigFromArgs,
    transitionChain,
} from './adloggs-mapper';
import { AdloggsPickupConfig, AdloggsStatus } from '../types';

const pickup: AdloggsPickupConfig = {
    name: 'KaaiKani Madurai',
    phone: '+91 90000 00001',
    address: '12 West Masi Street, Madurai',
    lat: 9.9195,
    long: 78.1193,
    pincode: '625001',
    city: 'Madurai',
    state: 'Tamilnadu',
};

const order = (over: any = {}): any => ({
    code: 'KK12345',
    totalWithTax: 45550, // paise → ₹455.50
    customer: { firstName: 'Somu', lastName: 'K', phoneNumber: '9500303976' },
    shippingAddress: {
        fullName: 'Somu K',
        streetLine1: '10 North Street',
        streetLine2: 'Near school',
        city: 'Madurai',
        province: 'Tamilnadu',
        postalCode: '625002',
        phoneNumber: '+919500303976',
        customFields: { latitude: 9.93, longitude: 78.12 },
    },
    lines: [
        {
            quantity: 2,
            unitPriceWithTax: 10025, // ₹100.25 each
            productVariant: { name: 'Atta 1kg' },
        },
    ],
    ...over,
});

describe('normalizePhone', () => {
    it('strips +91 and formatting down to 10 digits', () => {
        expect(normalizePhone('+91 95003 03976')).toBe('9500303976');
        expect(normalizePhone('919500303976')).toBe('9500303976');
        expect(normalizePhone('9500303976')).toBe('9500303976');
    });
    it('handles empty values', () => {
        expect(normalizePhone(undefined)).toBe('');
        expect(normalizePhone(null)).toBe('');
    });
});

describe('paiseToRupeeString', () => {
    it('converts paise to two-decimal rupee strings', () => {
        expect(paiseToRupeeString(45550)).toBe('455.50');
        expect(paiseToRupeeString(0)).toBe('0.00');
    });
});

describe('formatPickupDateTime', () => {
    it('renders IST time with the pickup buffer', () => {
        // 2026-08-26 09:00:00 UTC = 14:30 IST; +15 min buffer = 14:45
        const now = new Date(Date.UTC(2026, 7, 26, 9, 0, 0));
        expect(formatPickupDateTime(now)).toBe('2026-08-26 14:45');
    });
    it('rolls over midnight correctly', () => {
        // 20:00 UTC = 01:30 IST next day; +15 = 01:45
        const now = new Date(Date.UTC(2026, 7, 26, 20, 0, 0));
        expect(formatPickupDateTime(now)).toBe('2026-08-27 01:45');
    });
});

describe('argsToRecord', () => {
    it('passes through a plain object (live calculator call)', () => {
        expect(argsToRecord({ pickupName: 'X', pickupLat: 9.9 })).toEqual({ pickupName: 'X', pickupLat: 9.9 });
    });
    it('converts the stored [{name, value}] shape', () => {
        expect(
            argsToRecord([
                { name: 'pickupName', value: 'X' },
                { name: 'pickupLat', value: '9.9' },
            ]),
        ).toEqual({ pickupName: 'X', pickupLat: '9.9' });
    });
    it('parses a JSON string of either shape', () => {
        expect(argsToRecord('[{"name":"pickupName","value":"X"}]')).toEqual({ pickupName: 'X' });
        expect(argsToRecord('not json')).toEqual({});
    });
});

describe('pickupConfigFromArgs', () => {
    const completeArgs = {
        pickupName: pickup.name,
        pickupPhone: pickup.phone,
        pickupAddress: pickup.address,
        pickupLat: pickup.lat,
        pickupLong: pickup.long,
        pickupPincode: pickup.pincode,
        pickupCity: pickup.city,
        pickupState: pickup.state,
    };

    it('extracts a complete config from calculator args', () => {
        const { config, missing } = pickupConfigFromArgs(completeArgs);
        expect(missing).toEqual([]);
        expect(config).toEqual(pickup);
    });
    it('coerces string lat/long from stored method args', () => {
        const stored = Object.entries({ ...completeArgs, pickupLat: '9.9195', pickupLong: '78.1193' }).map(
            ([name, value]) => ({ name, value }),
        );
        const { config } = pickupConfigFromArgs(stored);
        expect(config?.lat).toBe(9.9195);
        expect(config?.long).toBe(78.1193);
    });
    it('reads the JSON pickupConfig arg written by the map picker', () => {
        const json = JSON.stringify({
            name: pickup.name,
            phone: pickup.phone,
            address: pickup.address,
            lat: pickup.lat,
            long: pickup.long,
            pincode: pickup.pincode,
            city: pickup.city,
            state: pickup.state,
        });
        // Stored shape: [{ name, value }] with the JSON as the value.
        const { config, missing } = pickupConfigFromArgs([{ name: 'pickupConfig', value: json }]);
        expect(missing).toEqual([]);
        expect(config).toEqual(pickup);
        // Live calculator shape: typed object.
        expect(pickupConfigFromArgs({ pickupConfig: json }).config).toEqual(pickup);
    });
    it('names the missing fields of an incomplete pickupConfig JSON', () => {
        const { config, missing } = pickupConfigFromArgs({ pickupConfig: JSON.stringify({ name: 'X', lat: null }) });
        expect(config).toBeNull();
        expect(missing).toContain('pickupLat');
        expect(missing).toContain('pickupPhone');
        expect(missing).not.toContain('pickupName');
    });
    it('reports every missing field', () => {
        const { config, missing } = pickupConfigFromArgs({ pickupName: 'X' });
        expect(config).toBeNull();
        expect(missing).toContain('pickupLat');
        expect(missing).toContain('pickupState');
        expect(missing).not.toContain('pickupName');
    });
});

describe('buildAdloggsCreatePayload', () => {
    const now = new Date(Date.UTC(2026, 7, 26, 9, 0, 0));

    it('maps an order', () => {
        const payload = buildAdloggsCreatePayload({
            order: order(),
            pickup,
            delivery: { lat: 9.93, long: 78.12 },
            weightKg: 2.5,
            now,
        });
        expect(payload.partner_order_id).toBe('KK12345');
        expect(payload.payment_type).toBe('Online');
        expect(payload.collectible_amount).toBe(0);
        expect(payload.order_total_price).toBe('455.50');
        expect(payload.order_total_weight_in_kg).toBe('2.50');
        expect(payload.pickup_contact_no).toBe('9000000001');
        expect(payload.delivery_contact_no).toBe('9500303976');
        expect(payload.delivery_lat).toBe(9.93);
        expect(payload.delivery_long).toBe(78.12);
        expect(payload.items).toEqual([{ name: 'Atta 1kg', quantity: '2', price: '200.50' }]);
        expect(payload.order_category).toBe('Grocery');
        expect(payload.utc_offset).toBe(330);
        expect(payload.pickup_address_details.pincode).toBe('625001');
        expect(payload.delivery_address_details.pincode).toBe('625002');
    });

    it('is always prepaid — the Adloggs account does not allow COD', () => {
        const payload = buildAdloggsCreatePayload({ order: order(), pickup, delivery: { lat: 9.93, long: 78.12 }, weightKg: 0.5, now });
        expect(payload.payment_type).toBe('Online');
        expect(payload.collectible_amount).toBe(0);
    });

    it('falls back to customer name/phone when the address has none', () => {
        const o = order();
        o.shippingAddress.fullName = '';
        o.shippingAddress.phoneNumber = '';
        const payload = buildAdloggsCreatePayload({
            order: o,
            pickup,
            delivery: { lat: 9.93, long: 78.12 },
            weightKg: 1,
            now,
        });
        expect(payload.delivery_contact_name).toBe('Somu K');
        expect(payload.delivery_contact_no).toBe('9500303976');
    });
});

describe('delivery OTP', () => {
    const now = new Date('2026-10-17T07:00:00Z');

    it('sends the delivery OTP it is given', () => {
        const payload = buildAdloggsCreatePayload({
            order: order(), pickup, delivery: { lat: 9.93, long: 78.12 }, weightKg: 0.5, now, deliveryOtp: 4821,
        });
        expect(payload.delivery_otp).toBe(4821);
    });

    it('leaves delivery_otp out when none is given', () => {
        const payload = buildAdloggsCreatePayload({ order: order(), pickup, delivery: { lat: 9.93, long: 78.12 }, weightKg: 0.5, now });
        expect('delivery_otp' in payload).toBe(false);
    });

    it('generates 4-digit OTPs that never start with 0', () => {
        for (let i = 0; i < 500; i++) {
            const otp = generateDeliveryOtp();
            expect(Number.isInteger(otp)).toBe(true);
            expect(otp).toBeGreaterThanOrEqual(1000);
            expect(otp).toBeLessThanOrEqual(9999);
        }
    });
});

describe('transitionChain', () => {
    it('does nothing for pre-pickup statuses', () => {
        expect(transitionChain('Pending', AdloggsStatus.Pending)).toEqual([]);
        expect(transitionChain('Pending', AdloggsStatus.Assigned)).toEqual([]);
        expect(transitionChain('Pending', AdloggsStatus.ArrivedAtPickup)).toEqual([]);
    });

    it('ships on pickup', () => {
        expect(transitionChain('Pending', AdloggsStatus.PickedUp)).toEqual(['Shipped']);
        expect(transitionChain('Shipped', AdloggsStatus.PickedUp)).toEqual([]);
    });

    it('walks to OutforDelivery, catching up missed states', () => {
        expect(transitionChain('Shipped', AdloggsStatus.OutForDelivery)).toEqual(['OutforDelivery']);
        expect(transitionChain('Pending', AdloggsStatus.OutForDelivery)).toEqual(['Shipped', 'OutforDelivery']);
        expect(transitionChain('OutforDelivery', AdloggsStatus.ArrivedAtDelivery)).toEqual([]);
    });

    it('delivers via the legal path from any earlier state', () => {
        expect(transitionChain('OutforDelivery', AdloggsStatus.Delivered)).toEqual(['Delivered']);
        // Shipped → Delivered directly is legal; OutforDelivery is not forced in.
        expect(transitionChain('Shipped', AdloggsStatus.Delivered)).toEqual(['Delivered']);
        expect(transitionChain('Pending', AdloggsStatus.Delivered)).toEqual(['Shipped', 'Delivered']);
        expect(transitionChain('Delivered', AdloggsStatus.Delivered)).toEqual([]);
    });

    it('cancels only from Pending/Shipped', () => {
        expect(transitionChain('Pending', AdloggsStatus.Cancelled)).toEqual(['Cancelled']);
        expect(transitionChain('Shipped', AdloggsStatus.Cancelled)).toEqual(['Cancelled']);
        expect(transitionChain('OutforDelivery', AdloggsStatus.Cancelled)).toEqual([]);
        expect(transitionChain('Delivered', AdloggsStatus.Cancelled)).toEqual([]);
    });

    it('leaves return flows to the admin', () => {
        expect(transitionChain('OutforDelivery', AdloggsStatus.ReturnInitiated)).toEqual([]);
        expect(transitionChain('OutforDelivery', AdloggsStatus.RtoDelivered)).toEqual([]);
    });

    it('ignores unknown states defensively', () => {
        expect(transitionChain('Cancelled', AdloggsStatus.Delivered)).toEqual([]);
        expect(transitionChain('Cancelled', AdloggsStatus.Cancelled)).toEqual([]);
    });
});

describe('isStaleStatus', () => {
    it('ignores a late earlier status after a later one', () => {
        expect(isStaleStatus(AdloggsStatus.Delivered, AdloggsStatus.PickedUp)).toBe(true);
        expect(isStaleStatus(AdloggsStatus.OutForDelivery, AdloggsStatus.Assigned)).toBe(true);
    });
    it('allows forward progress and exact replays', () => {
        expect(isStaleStatus(AdloggsStatus.PickedUp, AdloggsStatus.Delivered)).toBe(false);
        expect(isStaleStatus(AdloggsStatus.Delivered, AdloggsStatus.Delivered)).toBe(false);
        expect(isStaleStatus(AdloggsStatus.Delivered, AdloggsStatus.ReturnInitiated)).toBe(false);
    });
    it('never blocks when nothing is stored or an id is unknown', () => {
        expect(isStaleStatus(null, AdloggsStatus.Assigned)).toBe(false);
        expect(isStaleStatus(undefined, AdloggsStatus.Assigned)).toBe(false);
        expect(isStaleStatus(AdloggsStatus.Delivered, 99)).toBe(false);
    });
});

describe('nearestPickup', () => {
    const madurai = { config: { ...pickup, lat: 9.9195, long: 78.1193 } };
    const coimbatore = { config: { ...pickup, lat: 11.0168, long: 76.9558 } };
    it('picks the store closest to the delivery pin', () => {
        expect(nearestPickup([madurai, coimbatore], 11.01, 76.96)).toBe(coimbatore);
        expect(nearestPickup([madurai, coimbatore], 9.93, 78.12)).toBe(madurai);
    });
    it('falls back to the first store without a delivery pin', () => {
        expect(nearestPickup([madurai, coimbatore], null, undefined)).toBe(madurai);
        expect(nearestPickup([], 11, 76)).toBeUndefined();
    });
});
