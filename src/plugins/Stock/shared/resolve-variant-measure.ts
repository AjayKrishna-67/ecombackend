import { ID, ProductVariant, RequestContext, TransactionalConnection } from '@vendure/core';

import { EMPTY_MEASURE, hasWeight, isResolved, toMeasure, VariantMeasure } from './measurement';

/**
 * Resolves the physical measurement of product variants from their options --
 * ProductOption.customFields.measureValue + measureUnit. The option is the only
 * source: the old ProductVariant `weight` and `stockUnit` custom fields were
 * removed, so a variant whose option carries no measurement resolves to
 * EMPTY_MEASURE (no grams, no unit).
 *
 *   1. the first option carrying a WEIGHT (g/kg)
 *   2. the first option carrying any other measurement (litre/ml/piece/...)
 *   3. nothing
 *
 * Why weight jumps the queue: weight is the only measurement the weight-pool
 * stock and the shipping calculators can do arithmetic with. If a variant ever
 * carries two measured options (a "1 Packet" next to a "250 g"), letting the
 * unit-only one win would null out `grams` and silently drop the product out
 * of its weight pool.
 *
 * Steps 1 and 2 do not care which option GROUP the measurement came from. That
 * is safe because only pack-size groups (Quantity: 250 g / 500 g / 1 KG) are
 * ever given measurements -- a Grade or Colour option has none, so it cannot
 * win. If a second group is ever given measurements too, the winner becomes the
 * first in `variant.options` order, which is not meaningful ordering: at that
 * point reintroduce an explicit marker on ProductOptionGroup to break the tie.
 *
 * Deliberately a plain function, not an @Injectable service: it is consumed by
 * six different plugins plus two config functions (a ShippingCalculator and a
 * custom OrderProcess), none of which share a Nest module. Every caller
 * already holds a TransactionalConnection, so DI buys nothing here and would
 * cost a providers entry in each plugin.
 */

/** MySQL chokes on unbounded IN lists; chunk the hydration query. */
const ID_CHUNK_SIZE = 500;

type MeasureMap = ReadonlyMap<string, VariantMeasure>;

/**
 * Batch entry point. Returns a map keyed by stringified variant id -- always
 * populated for every input variant, EMPTY_MEASURE where nothing resolved, so
 * callers never deal with undefined.
 *
 * Runs at most one extra query regardless of how many variants are passed.
 * Variants that already have `options` hydrated (with their `group`) skip the
 * query entirely.
 */
export async function resolveVariantMeasures(
    ctx: RequestContext,
    connection: TransactionalConnection,
    variants: ProductVariant[],
): Promise<MeasureMap> {
    const result = new Map<string, VariantMeasure>();
    if (variants.length === 0) {
        return result;
    }

    // Variants whose options (and each option's group) are already loaded can
    // be resolved in memory. Anything else needs hydrating.
    const needsHydration: ProductVariant[] = [];
    for (const variant of variants) {
        if (hasHydratedOptions(variant)) {
            result.set(String(variant.id), measureFromOptions((variant as any).options));
        } else {
            needsHydration.push(variant);
        }
    }

    if (needsHydration.length > 0) {
        const hydrated = await hydrateOptions(
            ctx,
            connection,
            needsHydration.map(v => v.id),
        );
        for (const variant of needsHydration) {
            const key = String(variant.id);
            result.set(key, measureFromOptions(hydrated.get(key)?.options ?? []));
        }
    }

    return result;
}

/** Single-variant convenience. Prefer the batch form inside loops. */
export async function resolveVariantMeasure(
    ctx: RequestContext,
    connection: TransactionalConnection,
    variant: ProductVariant,
): Promise<VariantMeasure> {
    const map = await resolveVariantMeasures(ctx, connection, [variant]);
    return map.get(String(variant.id)) ?? EMPTY_MEASURE;
}

/**
 * Weight in grams for a variant, or null when the measurement is not
 * weight-expressible (volume/counted units, or no measured option at all).
 * Callers doing weight maths should use this and handle null explicitly.
 */
export async function resolveVariantWeightGrams(
    ctx: RequestContext,
    connection: TransactionalConnection,
    variant: ProductVariant,
): Promise<number | null> {
    return (await resolveVariantMeasure(ctx, connection, variant)).grams;
}

// ── internals ──────────────────────────────────────────────────────────────

/**
 * `options` is a ManyToMany that is not loaded by default. The option's `group`
 * is deliberately NOT needed: the measurement is read off the option itself, so
 * `relations: ['options']` is sufficient hydration for any caller.
 */
function hasHydratedOptions(variant: ProductVariant): boolean {
    const options = (variant as any).options;
    // TypeORM leaves an unrequested relation `undefined` and sets `[]` when it
    // was requested and came back empty, so Array.isArray is the real signal.
    // An empty array is a legitimate hydrated state (single-variant products)
    // and must NOT trigger a query, or every such product pays for one.
    return Array.isArray(options);
}

/** Loads options for the given variant ids, chunked. */
async function hydrateOptions(
    ctx: RequestContext,
    connection: TransactionalConnection,
    variantIds: ID[],
): Promise<Map<string, ProductVariant>> {
    const byId = new Map<string, ProductVariant>();
    for (let i = 0; i < variantIds.length; i += ID_CHUNK_SIZE) {
        const chunk = variantIds.slice(i, i + ID_CHUNK_SIZE);
        const rows = await connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.options', 'option')
            .where('variant.id IN (:...chunk)', { chunk })
            .getMany();
        for (const row of rows) {
            byId.set(String(row.id), row);
        }
    }
    return byId;
}

/** Applies the resolution order above to one variant's options. */
function measureFromOptions(options: any[]): VariantMeasure {
    const optionMeasures = options
        .filter(o => o != null && o.deletedAt == null)
        .map(optionMeasure)
        .filter(isResolved);
    return optionMeasures.find(hasWeight) ?? optionMeasures[0] ?? EMPTY_MEASURE;
}

function optionMeasure(option: any): VariantMeasure {
    if (option == null) {
        return EMPTY_MEASURE;
    }
    const customFields = option.customFields ?? {};
    return toMeasure(customFields.measureValue, customFields.measureUnit, 'option');
}
