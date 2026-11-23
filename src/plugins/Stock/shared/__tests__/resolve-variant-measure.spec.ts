import { ProductVariant, RequestContext, TransactionalConnection } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { EMPTY_MEASURE, toMeasure } from '../measurement';
import { resolveVariantMeasures } from '../resolve-variant-measure';

/**
 * Every variant built here has `options` already populated, which puts the
 * resolver on its in-memory fast path -- so these tests exercise the whole
 * resolution order without a database. `connection` is
 * a poisoned stub: if the resolver ever reaches for it, the test fails loudly
 * rather than silently passing on a code path we did not mean to take.
 */
const ctx = {} as RequestContext;
const connection = {
    getRepository() {
        throw new Error('resolver hit the database on an already-hydrated variant');
    },
} as unknown as TransactionalConnection;

interface OptionSpec {
    measureValue?: number | null;
    measureUnit?: string | null;
    deletedAt?: Date | null;
}

function buildVariant(
    id: string,
    options: OptionSpec[] | undefined,
    variantCustomFields: Record<string, unknown> = {},
): ProductVariant {
    return {
        id,
        customFields: variantCustomFields,
        // No `group` on the options: the measurement is read off the option
        // itself, so `relations: ['options']` is all any caller needs.
        options: options?.map((o, i) => ({
            id: `${id}-opt-${i}`,
            deletedAt: o.deletedAt ?? null,
            customFields: { measureValue: o.measureValue ?? null, measureUnit: o.measureUnit ?? null },
        })),
    } as unknown as ProductVariant;
}

async function resolveOne(variant: ProductVariant) {
    const map = await resolveVariantMeasures(ctx, connection, [variant]);
    return map.get(String(variant.id))!;
}

describe('resolveVariantMeasures — option resolution', () => {
    it('1. reads the measurement off the option', async () => {
        const variant = buildVariant('v1', [{ measureValue: 1, measureUnit: 'kg' }]);
        expect(await resolveOne(variant)).toEqual(toMeasure(1, 'kg', 'option'));
    });

    // Grade / Colour / Origin options carry no measurement, so they cannot win
    // -- which is why no marker on the group is needed to disambiguate.
    it('1. ignores options that carry no measurement', async () => {
        const variant = buildVariant('v2', [
            { measureValue: null, measureUnit: null },
            { measureValue: 0.5, measureUnit: 'kg' },
        ]);
        const measure = await resolveOne(variant);
        expect(measure.grams).toBe(500);
        expect(measure.source).toBe('option');
    });

    // Documents the tie-break if a SECOND group is ever given measurements:
    // first in `variant.options` order wins, which is not meaningful ordering.
    // If that ever becomes a real case, add an explicit marker to the group.
    it('1. takes the first measured option when more than one qualifies', async () => {
        const variant = buildVariant('v3', [
            { measureValue: 250, measureUnit: 'g' },
            { measureValue: 999, measureUnit: 'g' },
        ]);
        expect((await resolveOne(variant)).grams).toBe(250);
    });

    it('1. skips soft-deleted options', async () => {
        const variant = buildVariant('v4', [
            { measureValue: 250, measureUnit: 'g', deletedAt: new Date('2026-01-01') },
        ]);
        expect((await resolveOne(variant)).source).toBe('none');
    });

    // A weighted option anywhere in the list beats an earlier unit-only one --
    // order within `variant.options` must not decide whether the pool works.
    it('1. picks the weighted option even when a non-weight option comes first', async () => {
        const variant = buildVariant('v5', [
            { measureValue: 1, measureUnit: 'piece' },
            { measureValue: 250, measureUnit: 'g' },
        ]);
        const measure = await resolveOne(variant);
        expect(measure.grams).toBe(250);
        expect(measure.source).toBe('option');
    });

    // With no weight on any option, the non-weight option is still a real
    // magnitude worth returning -- it just carries no grams.
    it('2. falls through to a non-weight option when no option carries weight', async () => {
        const variant = buildVariant('v6', [{ measureValue: 2, measureUnit: 'litre' }]);
        const measure = await resolveOne(variant);
        expect(measure.source).toBe('option');
        expect(measure.baseValue).toBe(2000);
        expect(measure.grams).toBeNull();
    });

    it('3. resolves to the empty sentinel when no option is measured', async () => {
        const variant = buildVariant('v7', []);
        const measure = await resolveOne(variant);
        expect(measure.source).toBe('none');
        expect(measure.grams).toBeNull();
    });

    // The ProductVariant `weight` and `stockUnit` custom fields were removed.
    // Their DB columns can outlive the config until the drop migration runs, so
    // a stale value must never leak back in as a measurement.
    it('ignores leftover variant weight and stockUnit values', async () => {
        const unmeasured = buildVariant('v8', [{}], { weight: 750, stockUnit: 'kg' });
        expect(await resolveOne(unmeasured)).toEqual(EMPTY_MEASURE);

        const packet = buildVariant('v9', [{ measureValue: 1, measureUnit: 'packet' }], {
            weight: 500,
        });
        const measure = await resolveOne(packet);
        expect(measure.source).toBe('option');
        expect(measure.grams).toBeNull();
    });
});

describe('resolveVariantMeasures — weight expressibility', () => {
    it('gives no grams for a volume unit, since there is no density table', async () => {
        const variant = buildVariant('v9', [
            { measureValue: 1, measureUnit: 'litre' },
        ]);
        const measure = await resolveOne(variant);
        expect(measure.grams).toBeNull();
        expect(measure.baseValue).toBe(1000);
        expect(measure.baseUnit).toBe('ml');
    });

    it('gives no grams for a counted unit', async () => {
        const variant = buildVariant('v10', [
            { measureValue: 6, measureUnit: 'piece' },
        ]);
        expect((await resolveOne(variant)).grams).toBeNull();
    });

    // A half-filled option row must not read as 0 g -- product-stock divides by
    // the weight to derive variant stock, so 0 would be a divide-by-zero.
    it('treats a zero or missing measureValue as unset, not as 0 g', async () => {
        const zero = buildVariant('v11', [
            { measureValue: 0, measureUnit: 'g' },
        ]);
        expect((await resolveOne(zero)).source).toBe('none');

        const noUnit = buildVariant('v12', [
            { measureValue: 500, measureUnit: null },
        ]);
        // No unit falls back to the default ('piece'), which is not weight.
        expect((await resolveOne(noUnit)).grams).toBeNull();
    });

    it('ignores an unknown unit code rather than guessing', async () => {
        const variant = buildVariant('v13', [
            { measureValue: 5, measureUnit: 'furlong' },
        ]);
        expect((await resolveOne(variant)).source).toBe('none');
    });
});

describe('resolveVariantMeasures — batch contract', () => {
    it('returns an entry for every input variant, including unresolvable ones', async () => {
        const variants = [
            buildVariant('a', [{ measureValue: 1, measureUnit: 'kg' }]),
            buildVariant('b', []),
            buildVariant('c', [{ measureValue: 2, measureUnit: 'litre' }]),
        ];
        const map = await resolveVariantMeasures(ctx, connection, variants);
        expect([...map.keys()].sort()).toEqual(['a', 'b', 'c']);
        expect(map.get('a')!.grams).toBe(1000);
        expect(map.get('b')!.source).toBe('none');
        expect(map.get('c')!.baseValue).toBe(2000);
    });

    it('short-circuits on an empty input without touching the database', async () => {
        const map = await resolveVariantMeasures(ctx, connection, []);
        expect(map.size).toBe(0);
    });

    // Guards the hydration heuristic: `options: []` means "loaded, none" and
    // must NOT trigger a query, or every single-variant product pays for one.
    it('treats an empty options array as hydrated', async () => {
        await expect(resolveOne(buildVariant('v14', []))).resolves.toBeDefined();
    });

    // ...whereas `options` left undefined genuinely is unloaded, and the
    // resolver must go to the database rather than silently reporting "none".
    it('treats a missing options relation as unhydrated', async () => {
        const variant = buildVariant('v15', undefined);
        await expect(resolveVariantMeasures(ctx, connection, [variant])).rejects.toThrow(
            /hit the database/,
        );
    });
});
