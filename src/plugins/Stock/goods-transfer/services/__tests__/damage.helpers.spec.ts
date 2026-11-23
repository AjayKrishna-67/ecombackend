import { describe, expect, it } from 'vitest';

import {
    DAMAGE_PHOTO_THRESHOLD_PCT,
    checkDamageCap,
    computeDamagePercent,
    findLinesMissingPhoto,
    isPhotoMandatory,
    validateDamageQuantity,
} from '../damage.helpers';

describe('computeDamagePercent (display value)', () => {
    it('computes 2-decimal percentage', () => {
        expect(computeDamagePercent(2000, 100000)).toBe('2.00'); // 2 kg of 100 kg
        expect(computeDamagePercent(8000, 100000)).toBe('8.00');
        expect(computeDamagePercent(1, 3)).toBe('33.33');
    });
    it('guards divide-by-zero', () => {
        expect(computeDamagePercent(5, 0)).toBe('0.00');
    });
    it('every size is valid (no threshold behaviour)', () => {
        // helper never throws or flags — it is the display value only.
        expect(computeDamagePercent(50, 100)).toBe('50.00');
        expect(computeDamagePercent(100, 100)).toBe('100.00');
    });
});

describe('isPhotoMandatory (GT-11, per line)', () => {
    it('threshold is 5%', () => {
        expect(DAMAGE_PHOTO_THRESHOLD_PCT).toBe(5);
    });

    it('boundary: below 5 optional, exactly 5 required, above 5 required', () => {
        expect(isPhotoMandatory(499, 10000)).toBe(false); // 4.99%
        expect(isPhotoMandatory(500, 10000)).toBe(true); // 5.00%
        expect(isPhotoMandatory(501, 10000)).toBe(true); // 5.01%
    });

    it('decides on the raw ratio, not the rounded display value', () => {
        // 4.999% displays as "5.00" but is genuinely below the threshold.
        expect(computeDamagePercent(4999, 100000)).toBe('5.00');
        expect(isPhotoMandatory(4999, 100000)).toBe(false);
    });

    it('is false when there is nothing to photograph', () => {
        expect(isPhotoMandatory(0, 100)).toBe(false);
        expect(isPhotoMandatory(5, 0)).toBe(false); // divide-by-zero guard
        expect(isPhotoMandatory(-5, 100)).toBe(false);
    });

    it('a total loss always requires a photo', () => {
        expect(isPhotoMandatory(100, 100)).toBe(true);
    });
});

describe('findLinesMissingPhoto (GT-11)', () => {
    const line = (over: Partial<Parameters<typeof findLinesMissingPhoto>[0][0]> = {}) => ({
        lineId: 1,
        productName: 'Rice',
        damaged: 20,
        received: 100,
        photoCount: 0,
        ...over,
    });

    it('flags a line over the threshold with no photo', () => {
        const missing = findLinesMissingPhoto([line()]);
        expect(missing).toEqual([{ lineId: 1, productName: 'Rice', percent: '20.00' }]);
    });

    it('accepts the same line once a photo is attached', () => {
        expect(findLinesMissingPhoto([line({ photoCount: 1 })])).toEqual([]);
    });

    it('ignores lines below the threshold even with no photo', () => {
        expect(findLinesMissingPhoto([line({ damaged: 2 })])).toEqual([]);
    });

    it('checks each line on its own — a small loss cannot excuse a large one', () => {
        // A: 2% no photo (fine), B: 20% no photo (must be flagged), C: 1% no photo (fine)
        const missing = findLinesMissingPhoto([
            line({ lineId: 'A', productName: 'Dal', damaged: 2, received: 100 }),
            line({ lineId: 'B', productName: 'Oil', damaged: 20, received: 100 }),
            line({ lineId: 'C', productName: 'Salt', damaged: 1, received: 100 }),
        ]);
        expect(missing.map(m => m.lineId)).toEqual(['B']);
    });

    it('a photo on the harmless line does not satisfy the damaged one', () => {
        const missing = findLinesMissingPhoto([
            line({ lineId: 'A', damaged: 2, received: 100, photoCount: 3 }),
            line({ lineId: 'B', damaged: 20, received: 100, photoCount: 0 }),
        ]);
        expect(missing.map(m => m.lineId)).toEqual(['B']);
    });

    it('names every offending product, not just the first', () => {
        const missing = findLinesMissingPhoto([
            line({ lineId: 'A', productName: 'Oil', damaged: 20, received: 100 }),
            line({ lineId: 'B', productName: 'Ghee', damaged: 50, received: 100 }),
        ]);
        expect(missing.map(m => m.productName)).toEqual(['Oil', 'Ghee']);
    });

    it('is empty for an empty request', () => {
        expect(findLinesMissingPhoto([])).toEqual([]);
    });
});

describe('checkDamageCap (V1 cumulative cap)', () => {
    it('allows within received', () => {
        expect(checkDamageCap(0, 30, 100)).toEqual({ ok: true, remaining: 70 });
        expect(checkDamageCap(30, 40, 100)).toEqual({ ok: true, remaining: 30 });
    });
    it('rejects when pending+approved+new exceeds received (100 vs 30+40+35)', () => {
        // already claimed 70 (30+40), new 35 → 105 > 100
        const r = checkDamageCap(70, 35, 100);
        expect(r.ok).toBe(false);
        expect(r.remaining).toBe(30);
        expect(r.message).toContain('exceeds the received quantity');
    });
    it('allows exactly filling to the cap', () => {
        expect(checkDamageCap(70, 30, 100)).toEqual({ ok: true, remaining: 0 });
    });
    it('rejects a single claim larger than received', () => {
        expect(checkDamageCap(0, 150, 100).ok).toBe(false);
    });
});

describe('validateDamageQuantity (XOR by unit)', () => {
    it('pool product needs grams only', () => {
        expect(validateDamageQuantity(true, null, 800)).toEqual({ ok: true, amount: 800 });
        expect(validateDamageQuantity(true, 5, null).ok).toBe(false); // pcs on pool
        expect(validateDamageQuantity(true, null, null).ok).toBe(false);
        expect(validateDamageQuantity(true, null, 0).ok).toBe(false);
    });
    it('PCS product needs pcs only', () => {
        expect(validateDamageQuantity(false, 4, null)).toEqual({ ok: true, amount: 4 });
        expect(validateDamageQuantity(false, null, 500).ok).toBe(false); // grams on pcs
        expect(validateDamageQuantity(false, -2, null).ok).toBe(false);
        expect(validateDamageQuantity(false, 2.5, null).ok).toBe(false);
    });

    it('pool product accepts kg, returning the amount in the stored unit (grams)', () => {
        // Everything downstream — the cap, the percentage, the stock deduction —
        // works in grams, so a kg claim must arrive already converted.
        expect(validateDamageQuantity(true, null, null, 1)).toEqual({ ok: true, amount: 1000 });
        expect(validateDamageQuantity(true, null, null, 0.25)).toEqual({ ok: true, amount: 250 });
    });

    it('pool product rejects kg and grams together', () => {
        const r = validateDamageQuantity(true, null, 1000, 1);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('damagedKg');
    });

    it('PCS product rejects a kg claim', () => {
        expect(validateDamageQuantity(false, null, null, 1.5).ok).toBe(false);
        expect(validateDamageQuantity(false, 4, null, 1.5).ok).toBe(false);
    });

    it('rejects a kg claim that rounds away to nothing', () => {
        expect(validateDamageQuantity(true, null, null, 0.0004).ok).toBe(false);
        expect(validateDamageQuantity(true, null, null, 0).ok).toBe(false);
        expect(validateDamageQuantity(true, null, null, -1).ok).toBe(false);
    });
});
