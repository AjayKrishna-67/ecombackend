import { describe, expect, it } from 'vitest';

import { TransferState } from '../../types';
import {
    ComparableLine,
    MAX_WEIGHT_KG,
    diffTransferLines,
    isEmptyDiff,
    isValidTransition,
    normalizeLineInput,
    pickSharedStockLocation,
    resolvePoolBase,
    resolveWeightGrams,
    summariseDiff,
    transferStateError,
} from '../goods-transfer.helpers';
import { resolvePoolUnitCode } from '../pool-unit.helper';
import { EMPTY_MEASURE, toMeasure } from '../../../shared/measurement';

describe('transferStateError (state guard)', () => {
    it('null when state allowed', () => {
        expect(transferStateError(TransferState.Draft, [TransferState.Draft], 'edit')).toBeNull();
    });
    it('message when state not allowed', () => {
        const msg = transferStateError(TransferState.Confirmed, [TransferState.Draft], 'edit lines');
        expect(msg).toContain('Cannot edit lines');
        expect(msg).toContain('CONFIRMED');
    });
});

describe('isValidTransition (forward-only, TDS §12)', () => {
    it('allows the three forward steps only', () => {
        expect(isValidTransition(TransferState.Draft, TransferState.Confirmed)).toBe(true);
        expect(isValidTransition(TransferState.Confirmed, TransferState.Dispatched)).toBe(true);
        expect(isValidTransition(TransferState.Dispatched, TransferState.Received)).toBe(true);
    });
    it('rejects skips, reversals and terminal moves', () => {
        expect(isValidTransition(TransferState.Draft, TransferState.Dispatched)).toBe(false);
        expect(isValidTransition(TransferState.Received, TransferState.Draft)).toBe(false);
        expect(isValidTransition(TransferState.Dispatched, TransferState.Confirmed)).toBe(false);
        expect(isValidTransition(TransferState.Received, TransferState.Received)).toBe(false);
    });
});

describe('normalizeLineInput (Q3a rules)', () => {
    const poolProduct = { id: 55, isPooled: true };
    const pcsProduct = { id: 77, isPooled: false };

    it('POOL product: product-level + grams, variant forced null', () => {
        const r = normalizeLineInput({ productId: 55, weightGrams: 50000 }, poolProduct);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value).toEqual({
                isPooled: true, productId: 55, productVariantId: null, quantityPcs: null, weightGrams: 50000,
                poolUnit: 'kg',
            });
        }
    });

    it('POOL product rejects PCS entry', () => {
        const r = normalizeLineInput({ productId: 55, quantityPcs: 10 }, poolProduct);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('pool product measured in kg');
    });

    it('PCS product: variant + pcs', () => {
        const r = normalizeLineInput({ productVariantId: 901, quantityPcs: 24 }, pcsProduct);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value).toEqual({
                isPooled: false, productId: 77, productVariantId: 901, quantityPcs: 24, weightGrams: null,
                poolUnit: null,
            });
        }
    });

    it('PCS product rejects grams entry', () => {
        const r = normalizeLineInput({ productVariantId: 901, weightGrams: 500 }, pcsProduct);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('PCS product');
    });

    it('PCS product requires variant id', () => {
        const r = normalizeLineInput({ quantityPcs: 5 }, pcsProduct);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('productVariantId');
    });

    it('rejects both / neither / non-positive / fractional values', () => {
        expect(normalizeLineInput({ quantityPcs: 5, weightGrams: 100 }, pcsProduct).ok).toBe(false);
        expect(normalizeLineInput({}, pcsProduct).ok).toBe(false);
        expect(normalizeLineInput({ productVariantId: 1, quantityPcs: 0 }, pcsProduct).ok).toBe(false);
        expect(normalizeLineInput({ productVariantId: 1, quantityPcs: -3 }, pcsProduct).ok).toBe(false);
        expect(normalizeLineInput({ weightGrams: 10.5 }, poolProduct).ok).toBe(false);
    });

    it('POOL product accepts kg and stores grams', () => {
        const r = normalizeLineInput({ productId: 55, weightKg: 50 }, poolProduct);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.weightGrams).toBe(50_000);
    });

    it('kg and grams reach the same stored value — the two units are interchangeable', () => {
        const viaKg = normalizeLineInput({ productId: 55, weightKg: 1.5 }, poolProduct);
        const viaGrams = normalizeLineInput({ productId: 55, weightGrams: 1500 }, poolProduct);
        expect(viaKg.ok && viaGrams.ok).toBe(true);
        if (viaKg.ok && viaGrams.ok) {
            expect(viaKg.value.weightGrams).toBe(viaGrams.value.weightGrams);
        }
    });

    it('accepts the small end of the catalogue in kg (50 g pouch)', () => {
        const r = normalizeLineInput({ productId: 55, weightKg: 0.05 }, poolProduct);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.weightGrams).toBe(50);
    });

    it('POOL product rejects kg and grams together — one unit per line', () => {
        const r = normalizeLineInput({ productId: 55, weightKg: 1, weightGrams: 1000 }, poolProduct);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('not both');
    });

    it('PCS product rejects a kg entry', () => {
        const r = normalizeLineInput({ productVariantId: 901, weightKg: 2 }, pcsProduct);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('PCS product');
    });

    it('rejects a kg value that rounds away to nothing, naming it in kg', () => {
        const r = normalizeLineInput({ productId: 55, weightKg: 0.0004 }, poolProduct);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('under one gram');
    });

    it('rejects zero, negative and non-finite kg', () => {
        expect(normalizeLineInput({ productId: 55, weightKg: 0 }, poolProduct).ok).toBe(false);
        expect(normalizeLineInput({ productId: 55, weightKg: -2 }, poolProduct).ok).toBe(false);
        expect(normalizeLineInput({ productId: 55, weightKg: NaN }, poolProduct).ok).toBe(false);
        expect(normalizeLineInput({ productId: 55, weightKg: Infinity }, poolProduct).ok).toBe(false);
    });

    it('rounds a fractional gram to the nearest whole gram — the column is an integer', () => {
        const r = normalizeLineInput({ productId: 55, weightKg: 1.0005 }, poolProduct);
        expect(r.ok).toBe(true);
        // 1.0005 kg = 1000.5 g -> 1001 g (round half up, as money does)
        if (r.ok) expect(r.value.weightGrams).toBe(1001);
    });

    it('enforces the 100-tonne ceiling in kg as well as grams', () => {
        expect(normalizeLineInput({ productId: 55, weightKg: MAX_WEIGHT_KG }, poolProduct).ok).toBe(true);
        const over = normalizeLineInput({ productId: 55, weightKg: MAX_WEIGHT_KG + 1 }, poolProduct);
        expect(over.ok).toBe(false);
        if (!over.ok) expect(over.error).toContain('kg');
    });
});

describe('resolveWeightGrams (SPEC §6 — kg or grams, one stored unit)', () => {
    it('returns null grams when no weight was sent — a PCS line is not an error here', () => {
        const r = resolveWeightGrams({});
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.grams).toBeNull();
    });

    it('passes whole grams straight through', () => {
        const r = resolveWeightGrams({ weightGrams: 250 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.grams).toBe(250);
    });

    it('names the caller own fields in the error, so the damage flow never cites weightKg', () => {
        const r = resolveWeightGrams(
            { weightKg: 1, weightGrams: 1000 },
            { kg: 'damagedKg', grams: 'damagedGrams' },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain('damagedKg');
            expect(r.error).not.toContain('weightKg');
        }
    });
});

describe('diffTransferLines (SPEC §4 — what the destination is told changed)', () => {
    const pcs = (variantId: number, name: string, qty: number): ComparableLine => ({
        productId: 1,
        productVariantId: variantId,
        isPooled: false,
        productName: name,
        sku: `SKU-${variantId}`,
        quantityPcs: qty,
        weightGrams: null,
    });
    const pool = (
        productId: number,
        name: string,
        base: number,
        poolUnit = 'kg',
    ): ComparableLine => ({
        productId,
        productVariantId: null,
        isPooled: true,
        productName: name,
        sku: `SKU-P${productId}`,
        quantityPcs: null,
        weightGrams: base,
        poolUnit,
    });

    it('reports nothing when the line set is unchanged', () => {
        const lines = [pcs(10, 'Rice', 5), pool(20, 'Onions', 50_000)];
        const diff = diffTransferLines(lines, lines);
        expect(isEmptyDiff(diff)).toBe(true);
        expect(summariseDiff(diff)).toBe('');
    });

    it('detects an added line — the "stop the vehicle" case', () => {
        const diff = diffTransferLines([pcs(10, 'Rice', 5)], [pcs(10, 'Rice', 5), pcs(11, 'Dal', 2)]);
        expect(diff.added).toEqual([{ productName: 'Dal', sku: 'SKU-11', quantity: 2, unit: 'pcs' }]);
        expect(diff.removed).toHaveLength(0);
        expect(summariseDiff(diff)).toBe('1 item added');
    });

    it('detects a removed line — the forgotten-product case', () => {
        const diff = diffTransferLines([pcs(10, 'Rice', 5), pcs(11, 'Dal', 2)], [pcs(10, 'Rice', 5)]);
        expect(diff.removed).toEqual([{ productName: 'Dal', sku: 'SKU-11', quantity: 2, unit: 'pcs' }]);
        expect(diff.added).toHaveLength(0);
        expect(summariseDiff(diff)).toBe('1 removed');
    });

    it('detects a quantity change without reporting add or remove', () => {
        const diff = diffTransferLines([pcs(10, 'Rice', 5)], [pcs(10, 'Rice', 8)]);
        expect(diff.quantityChanged).toEqual([
            { productName: 'Rice', sku: 'SKU-10', from: 5, to: 8, unit: 'pcs' },
        ]);
        expect(diff.added).toHaveLength(0);
        expect(diff.removed).toHaveLength(0);
    });

    it('compares pooled lines by product and in grams', () => {
        const diff = diffTransferLines([pool(20, 'Onions', 50_000)], [pool(20, 'Onions', 45_000)]);
        expect(diff.quantityChanged).toEqual([
            { productName: 'Onions', sku: 'SKU-P20', from: 50_000, to: 45_000, unit: 'g' },
        ]);
    });

    it('does not confuse a pooled product with a PCS variant of the same product id', () => {
        const diff = diffTransferLines([pool(1, 'Onions', 50_000)], [pcs(1, 'Onions', 50)]);
        expect(diff.removed).toHaveLength(1);
        expect(diff.added).toHaveLength(1);
        expect(diff.quantityChanged).toHaveLength(0);
    });

    it('summarises every kind of change in one sentence', () => {
        const diff = diffTransferLines(
            [pcs(10, 'Rice', 5), pcs(11, 'Dal', 2)],
            [pcs(10, 'Rice', 8), pcs(12, 'Sugar', 1)],
        );
        expect(summariseDiff(diff)).toBe('1 item added, 1 removed, 1 quantity changed');
    });
});

/*
  A pooled product is not automatically a weighed one.

  Product.customFields.productStockEnabled says stock is held in ONE pool at product
  level; the unit of that pool comes from the measurement option, and for this
  catalogue it is pieces as often as it is kilograms — Amla is sold as "Amla 10 no."
  and "Amla 25 no.", and its pool counts amlas. This module read the flag alone,
  called every pool a weight, and multiplied whatever was typed by a thousand on the
  way in. These cover the two halves of that: reading the unit, and refusing the
  inputs that only make sense for a weight.
*/
describe('resolvePoolUnitCode (what a pool is counted in)', () => {
    const measures = (entries: Record<string, ReturnType<typeof toMeasure>>) =>
        new Map(Object.entries(entries));

    it('reads kilograms off a weight-authored option group', () => {
        expect(resolvePoolUnitCode(measures({ v1: toMeasure(250, 'g', 'option') }))).toBe('kg');
        expect(resolvePoolUnitCode(measures({ v1: toMeasure(1, 'kg', 'option') }))).toBe('kg');
    });

    it('reads pieces off a counted option group — the Amla case', () => {
        // "Amla 10 no." and "Amla 25 no.", exactly as the catalogue authors them.
        const actual = resolvePoolUnitCode(
            measures({ v170: toMeasure(10, 'piece', 'option'), v171: toMeasure(25, 'packet', 'option') }),
        );
        expect(actual).toBe('piece');
    });

    it('reads litres off a volume group', () => {
        expect(resolvePoolUnitCode(measures({ v1: toMeasure(500, 'ml', 'option') }))).toBe('litre');
    });

    it('keeps a weight pool weighed when a stray counted option joins the group', () => {
        // Option groups are shared across hundreds of products, so one "1 Packet"
        // option must not reclassify a product that is genuinely weighed. Same
        // precedence resolvePoolMeasure applies to the stock maths itself.
        const actual = resolvePoolUnitCode(
            measures({ v1: toMeasure(500, 'g', 'option'), v2: toMeasure(1, 'packet', 'option') }),
        );
        expect(actual).toBe('kg');
    });

    it('falls back to kilograms when the catalogue says nothing at all', () => {
        // Not 'piece', though that is the unit table's default: this is the unit the
        // module used before it could read the real one, so a product with no data
        // keeps meaning what it already meant instead of silently changing.
        expect(resolvePoolUnitCode(measures({ v1: EMPTY_MEASURE }))).toBe('kg');
        expect(resolvePoolUnitCode(new Map())).toBe('kg');
    });
});

describe('resolvePoolBase (entering a quantity in the pool own unit)', () => {
    it('converts kilograms to grams', () => {
        expect(resolvePoolBase({ poolQty: 1.5 }, 'kg')).toEqual({ ok: true, base: 1500 });
    });

    it('stores a piece count as itself — 30 lemons are 30, not 30000', () => {
        expect(resolvePoolBase({ poolQty: 30 }, 'piece')).toEqual({ ok: true, base: 30 });
    });

    it('converts litres to millilitres', () => {
        expect(resolvePoolBase({ poolQty: 2 }, 'litre')).toEqual({ ok: true, base: 2000 });
    });

    it('REFUSES weightKg on a counted pool instead of multiplying it by a thousand', () => {
        const r = resolvePoolBase({ weightKg: 30 }, 'piece');
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain('measured in pcs');
            expect(r.error).toContain('poolQty');
        }
    });

    it('REFUSES weightGrams on a counted pool for the same reason', () => {
        expect(resolvePoolBase({ weightGrams: 30 }, 'piece').ok).toBe(false);
    });

    it('still accepts kg and grams on a genuinely weighed pool', () => {
        expect(resolvePoolBase({ weightKg: 1.5 }, 'kg')).toEqual({ ok: true, base: 1500 });
        expect(resolvePoolBase({ weightGrams: 1500 }, 'kg')).toEqual({ ok: true, base: 1500 });
    });

    it('refuses a fractional count — there is no half lemon to load', () => {
        const r = resolvePoolBase({ poolQty: 2.5 }, 'piece');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('whole number of pcs');
    });

    it('accepts a fractional weight, which is the whole point of kg', () => {
        expect(resolvePoolBase({ poolQty: 0.05 }, 'kg')).toEqual({ ok: true, base: 50 });
    });

    it('rejects zero, negatives and a value that rounds away to nothing', () => {
        expect(resolvePoolBase({ poolQty: 0 }, 'kg').ok).toBe(false);
        expect(resolvePoolBase({ poolQty: -1 }, 'piece').ok).toBe(false);
        expect(resolvePoolBase({ poolQty: 0.0004 }, 'kg').ok).toBe(false);
    });

    it('returns a null base when nothing was sent — a PCS line is not an error here', () => {
        expect(resolvePoolBase({}, 'kg')).toEqual({ ok: true, base: null });
    });

    it('refuses poolQty and a weight together — one spelling per line', () => {
        expect(resolvePoolBase({ poolQty: 1, weightKg: 1 }, 'kg').ok).toBe(false);
    });
});

describe('normalizeLineInput on a counted pool (the Amla regression)', () => {
    const amla = { id: 83, isPooled: true, poolUnit: 'piece' };

    it('stores thirty amlas as thirty', () => {
        const r = normalizeLineInput({ productId: 83, poolQty: 30 }, amla);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value).toEqual({
                isPooled: true,
                productId: 83,
                productVariantId: null,
                quantityPcs: null,
                weightGrams: 30,
                poolUnit: 'piece',
            });
        }
    });

    it('refuses the kilogram spelling that used to make that thirty a thirty thousand', () => {
        const r = normalizeLineInput({ productId: 83, weightKg: 30 }, amla);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('measured in pcs');
    });

    it('still refuses a PCS entry — a pool is entered at product level either way', () => {
        const r = normalizeLineInput({ productId: 83, quantityPcs: 30 }, amla);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('pool product measured in pcs');
    });
});

describe('pickSharedStockLocation (one stock base across branches)', () => {
    const madurai = { id: 2, name: 'Madurai', channelCount: 7 };
    const fruit = { id: 10, name: 'kaaikani-Fruit', channelCount: 5 };
    const offer = { id: 11, name: 'Kaaikani-Offer', channelCount: 5 };

    it('prefers the location named after the sending branch', () => {
        expect(pickSharedStockLocation([fruit, madurai, offer], 'Madurai', 'Coimbatore')).toBe(madurai);
    });
    it('falls back to the location named after the receiving branch', () => {
        expect(pickSharedStockLocation([fruit, madurai], 'Coimbatore', 'madurai ')).toBe(madurai);
    });
    it('without a name match, takes the location most branches share', () => {
        expect(pickSharedStockLocation([fruit, offer, madurai], 'Coimbatore', 'Salem')).toBe(madurai);
    });
    it('breaks ties on the lowest id', () => {
        expect(pickSharedStockLocation([offer, fruit], 'Coimbatore', 'Salem')).toBe(fruit);
    });
});
