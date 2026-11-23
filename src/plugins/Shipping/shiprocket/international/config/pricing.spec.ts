import { describe, expect, it } from 'vitest';

import { ShiprocketCourier } from '../types';
import {
    baseRateInr,
    computeFinalMinorUnits,
    eddDays,
    findCourierByName,
    selectBox,
    slabMarkupInr,
    tariffTotalInr,
} from './pricing';

const courier = (over: Partial<ShiprocketCourier> = {}): ShiprocketCourier => ({
    courier_company_id: 384,
    courier_name: 'SRX Economy',
    is_international: 1,
    etd: '',
    estimated_delivery_days: '',
    rate: { rate: 816, extra_info: { edd: { from: 10, to: 12 } } },
    extra_charges: [{ name: 'Forward Charges', value: '816.00' }],
    tariff: { '61091000': 15 },
    ...over,
});

describe('selectBox', () => {
    const brackets = [
        { maxGrams: 2000, length: 20, breadth: 15, height: 10 },
        { maxGrams: 5000, length: 30, breadth: 25, height: 15 },
    ];

    it('picks the smallest bracket that fits (inclusive upper bound)', () => {
        expect(selectBox(brackets, 1500)?.length).toBe(20);
        expect(selectBox(brackets, 2000)?.length).toBe(20);
        expect(selectBox(brackets, 2001)?.length).toBe(30);
    });

    it('falls back to the largest bracket when over the top', () => {
        expect(selectBox(brackets, 9999)?.length).toBe(30);
    });

    it('is order-independent (sorts by maxGrams)', () => {
        expect(selectBox([brackets[1], brackets[0]], 1500)?.length).toBe(20);
    });

    it('returns undefined when there are no brackets', () => {
        expect(selectBox([], 1000)).toBeUndefined();
    });
});

describe('findCourierByName', () => {
    const couriers = [
        courier({ courier_company_id: 384, courier_name: 'SRX Economy' }),
        courier({ courier_company_id: 35, courier_name: 'Aramex International' }),
    ];

    it('matches case-insensitively and trims whitespace', () => {
        expect(findCourierByName(couriers, '  srx economy ')?.courier_company_id).toBe(384);
        expect(findCourierByName(couriers, 'ARAMEX INTERNATIONAL')?.courier_company_id).toBe(35);
    });

    it('returns undefined for no match or empty name', () => {
        expect(findCourierByName(couriers, 'DHL')).toBeUndefined();
        expect(findCourierByName(couriers, '')).toBeUndefined();
    });
});

describe('baseRateInr', () => {
    it('uses rate.rate — the full freight, which includes surcharges (e.g. Remote Area Surcharge)', () => {
        // SRX Premium: rate.rate 2049.77 = Forward Charges 1938 + Remote Area Surcharge 111.77.
        expect(baseRateInr(courier({ rate: { rate: 2049.77 } }))).toBe(2049.77);
    });

    it('equals rate.total for couriers that populate total (India Post: total == rate.rate)', () => {
        expect(baseRateInr(courier({ rate: { rate: 1776.2, total: 1776.2 } }))).toBe(1776.2);
    });

    it('falls back to rate.total when rate.rate is missing or non-positive', () => {
        expect(baseRateInr(courier({ rate: { rate: 0, total: 1776.2 } }))).toBe(1776.2);
    });

    it('is 0 when neither rate.rate nor rate.total is a positive number', () => {
        expect(baseRateInr(courier({ rate: { rate: 0 } }))).toBe(0);
    });
});

describe('slabMarkupInr', () => {
    it('rounds slabs up: 1500g / 500g × ₹200 = ₹600', () => {
        expect(slabMarkupInr(1500, 500, 200)).toBe(600);
    });
    it('partial slab still counts as a full slab: 1600g / 500g = 4 slabs', () => {
        expect(slabMarkupInr(1600, 500, 200)).toBe(800);
    });
    it('is 0 when the slab size is not positive', () => {
        expect(slabMarkupInr(1500, 0, 200)).toBe(0);
    });
});

describe('eddDays', () => {
    it('reads the from/to delivery window from rate.extra_info.edd', () => {
        expect(eddDays(courier())).toEqual({ from: 10, to: 12 });
    });
    it('returns nulls when the edd window is absent', () => {
        expect(eddDays(courier({ rate: { rate: 816 } }))).toEqual({ from: null, to: null });
    });
});

describe('tariffTotalInr', () => {
    it('sums tariff map values', () => {
        expect(tariffTotalInr(courier({ tariff: { a: 15, b: 5 } }))).toBe(20);
    });
    it('is 0 for an empty tariff', () => {
        expect(tariffTotalInr(courier({ tariff: {} }))).toBe(0);
    });
});

describe('computeFinalMinorUnits', () => {
    it('base + slab + static, fx=1 → ×100 paise (tariff not charged)', () => {
        // 816 + (1500/500×200=600) + 50 = 1466 → 146600 paise
        expect(
            computeFinalMinorUnits({
                baseInr: 816,
                weightGrams: 1500,
                grams: 500,
                gramsPerAmount: 200,
                staticCharge: 50,
                fxRate: 1,
            }),
        ).toBe(146600);
    });

    it('applies the FX rate: ₹1660 / 83 = $20.00 → 2000 cents', () => {
        expect(
            computeFinalMinorUnits({
                baseInr: 1660,
                weightGrams: 0,
                grams: 0,
                gramsPerAmount: 0,
                staticCharge: 0,
                fxRate: 83,
            }),
        ).toBe(2000);
    });

    it('treats fxRate <= 0 as 1 (no conversion)', () => {
        expect(
            computeFinalMinorUnits({
                baseInr: 100,
                weightGrams: 0,
                grams: 0,
                gramsPerAmount: 0,
                staticCharge: 0,
                fxRate: 0,
            }),
        ).toBe(10000);
    });
});
