import { describe, expect, it } from 'vitest';
import { EMPTY_MEASURE, toMeasure, VariantMeasure } from '../measurement';
import {
    displayUnitForBase,
    poolExclusionReason,
    poolInputStep,
    poolUnitLabel,
    resolvePoolMeasure,
} from '../pool-measure';

function measures(entries: Record<string, VariantMeasure>): Map<string, VariantMeasure> {
    return new Map(Object.entries(entries));
}

describe('resolvePoolMeasure', () => {
    /**
     * The catalogue's existing shape: 171 of 179 pool-enabled products are
     * authored in g/kg. Every one of them must keep dividing a gram pool by the
     * same numbers as before, or live stock moves.
     */
    it('resolves a kg-authored product to a gram pool', () => {
        const actual = resolvePoolMeasure(
            measures({
                '1': toMeasure(0.25, 'kg', 'option'),
                '2': toMeasure(1, 'kg', 'option'),
            }),
        );

        expect(actual?.baseUnit).toBe('g');
        expect(actual?.drawByVariantId.get('1')).toBe(250);
        expect(actual?.drawByVariantId.get('2')).toBe(1000);
        expect(actual?.excludedVariantIds).toEqual([]);
    });

    it('resolves a Pieces-authored product to a piece pool', () => {
        // Lemon: options "5 Nos", "10 Nos", "20 Nos".
        const actual = resolvePoolMeasure(
            measures({
                '167': toMeasure(5, 'piece', 'option'),
                '168': toMeasure(10, 'piece', 'option'),
                '169': toMeasure(20, 'piece', 'option'),
            }),
        );

        expect(actual?.baseUnit).toBe('piece');
        expect(actual?.drawByVariantId.get('167')).toBe(5);
        expect(actual?.drawByVariantId.get('169')).toBe(20);
    });

    it('treats packets and dozens as the same piece base', () => {
        const actual = resolvePoolMeasure(
            measures({
                '1': toMeasure(1, 'packet', 'option'),
                '2': toMeasure(1, 'dozen', 'option'),
            }),
        );

        expect(actual?.baseUnit).toBe('piece');
        expect(actual?.drawByVariantId.size).toBe(2);
    });

    /**
     * THE regression guard. Before this module the pool filtered on `hasWeight`,
     * so a counted variant sitting on an otherwise weight-authored product was
     * silently skipped. Weight winning the precedence reproduces that exactly —
     * if this ever flips to a piece pool, every weight product on the same shape
     * starts dividing grams by a piece count.
     */
    it('keeps a mixed product on its weight pool and excludes the counted variant', () => {
        const actual = resolvePoolMeasure(
            measures({
                'weighed': toMeasure(0.5, 'kg', 'option'),
                'counted': toMeasure(6, 'piece', 'option'),
            }),
        );

        expect(actual?.baseUnit).toBe('g');
        expect(actual?.drawByVariantId.get('weighed')).toBe(500);
        expect(actual?.drawByVariantId.has('counted')).toBe(false);
        expect(actual?.excludedVariantIds).toEqual(['counted']);
    });

    it('returns null when nothing resolved at all', () => {
        expect(resolvePoolMeasure(measures({ '1': EMPTY_MEASURE }))).toBeNull();
    });

    it('returns null for an empty product', () => {
        expect(resolvePoolMeasure(new Map())).toBeNull();
    });

    it('ignores a zero or negative magnitude rather than dividing by it', () => {
        const actual = resolvePoolMeasure(
            measures({
                'zero': toMeasure(0, 'kg', 'option'),
                'real': toMeasure(2, 'kg', 'option'),
            }),
        );

        expect(actual?.drawByVariantId.has('zero')).toBe(false);
        expect(actual?.drawByVariantId.get('real')).toBe(2000);
    });

    it('resolves a litre-authored product to a millilitre pool', () => {
        const actual = resolvePoolMeasure(measures({ '1': toMeasure(1, 'litre', 'option') }));

        expect(actual?.baseUnit).toBe('ml');
        expect(actual?.drawByVariantId.get('1')).toBe(1000);
    });
});

describe('pool arithmetic is the same in every base', () => {
    /** The division the service, resolver and strategy all perform. */
    const sellable = (poolRemaining: number, draw: number) =>
        Math.max(0, Math.floor(poolRemaining / draw));

    it('divides a weight pool as it always has', () => {
        const pool = resolvePoolMeasure(measures({ '1': toMeasure(0.25, 'kg', 'option') }))!;

        // 50 kg pool, 250 g variant -> 200 sellable units.
        expect(sellable(50_000, pool.drawByVariantId.get('1')!)).toBe(200);
    });

    it('divides a piece pool by the count per pack', () => {
        const pool = resolvePoolMeasure(measures({ '169': toMeasure(20, 'piece', 'option') }))!;

        // 500 lemons in the pool, 20 per pack -> 25 sellable packs.
        expect(sellable(500, pool.drawByVariantId.get('169')!)).toBe(25);
    });

    it('never reports a negative count when the pool is oversold', () => {
        const pool = resolvePoolMeasure(measures({ '1': toMeasure(5, 'piece', 'option') }))!;

        expect(sellable(-30, pool.drawByVariantId.get('1')!)).toBe(0);
    });
});

describe('display helpers', () => {
    it('scales a measured pool up for a human and leaves a counted one alone', () => {
        expect(displayUnitForBase('g')).toBe('kg');
        expect(displayUnitForBase('ml')).toBe('litre');
        expect(displayUnitForBase('piece')).toBe('piece');
    });

    it('labels each pool in the terms an operator reads', () => {
        expect(poolUnitLabel('g')).toBe('kg');
        expect(poolUnitLabel('ml')).toBe('L');
        expect(poolUnitLabel('piece')).toBe('pcs');
    });

    it('lets a weight pool take fractions but keeps a counted pool whole', () => {
        expect(poolInputStep('g')).toBe('0.001');
        expect(poolInputStep('piece')).toBe('1');
    });
});

describe('poolExclusionReason', () => {
    /**
     * The bug this function exists for. Product 82 half-authored: variant 169's
     * option got a Measure Value, variant 168's never did. 168 resolves
     * EMPTY_MEASURE, whose baseUnit defaults to 'piece', and the pool is a
     * piece pool too — so the old `pool ? mismatch : ...` guess printed "its
     * base unit 'piece' differs from the pool's 'piece'" and sent whoever read
     * it to check units that were already right.
     */
    it('blames the missing magnitude, not a unit mismatch, for an unmeasured variant', () => {
        const measure = EMPTY_MEASURE;
        const pool = resolvePoolMeasure(
            measures({
                '168': measure,
                '169': toMeasure(20, 'piece', 'option'),
            }),
        );

        // Not excluded — it never had a magnitude to be in a different base.
        expect(pool?.excludedVariantIds).toEqual([]);
        expect(poolExclusionReason(pool, '168', measure)).toBe(
            "it carries no measureValue of its own (the pool is in 'piece')",
        );
    });

    it('reports a genuine base mismatch for a counted variant on a weight pool', () => {
        const counted = toMeasure(6, 'piece', 'option');
        const pool = resolvePoolMeasure(
            measures({
                'weighed': toMeasure(0.5, 'kg', 'option'),
                'counted': counted,
            }),
        );

        expect(pool?.excludedVariantIds).toEqual(['counted']);
        expect(poolExclusionReason(pool, 'counted', counted)).toBe(
            "its base unit 'piece' differs from the pool's 'g'",
        );
    });

    it('reports no pool at all when nothing on the product was measured', () => {
        expect(poolExclusionReason(null, '168', EMPTY_MEASURE)).toBe(
            'no variant of this product carries a measureValue',
        );
    });

    /**
     * An unmeasured variant on a GRAM pool must not be told its unit is wrong
     * either — same missing-magnitude cause, and naming the pool's unit tells
     * the operator which unit to author the value in.
     */
    it('names the pool unit so the operator knows what to author in', () => {
        const measure = EMPTY_MEASURE;
        const pool = resolvePoolMeasure(measures({ '1': toMeasure(0.5, 'kg', 'option'), '2': measure }));

        expect(poolExclusionReason(pool, '2', measure)).toBe(
            "it carries no measureValue of its own (the pool is in 'g')",
        );
    });
});
