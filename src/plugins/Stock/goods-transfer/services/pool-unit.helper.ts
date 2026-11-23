import { ID, ProductVariant, RequestContext, TransactionalConnection } from '@vendure/core';
import { In, IsNull } from 'typeorm';

import { VariantMeasure } from '../../shared/measurement';
import { displayUnitForBase, resolvePoolMeasure } from '../../shared/pool-measure';
import { resolveVariantMeasures } from '../../shared/resolve-variant-measure';
import { STOCK_UNITS } from '../../shared/stock-units';

/**
 * What a pooled product's stock pool is COUNTED IN, for this module's screens and
 * documents.
 *
 * `Product.customFields.productStockEnabled` says stock is held in one pool at
 * product level. It does NOT say the pool is a weight — that is decided by the
 * measurement option the merchant attached, and shared/pool-measure.ts has always
 * derived it. This module was the only consumer that skipped that step and assumed
 * every pool was grams, which put "KG" beside products counted in pieces (Amla,
 * Lemon, bananas, keerai kattu) and multiplied whatever was typed by 1000 on its way
 * into a piece pool. Everything else -- cart validation, the order process, the
 * Product Stock block -- already read the unit properly; this brings transfers in
 * line with them rather than inventing a second answer.
 *
 * Returns a DISPLAY unit code from shared/stock-units: 'kg', 'litre' or 'piece'.
 * Storage stays the base integer (g / ml / piece), so `toBase` and `fromBase` convert
 * with no special cases and a 1.5 kg line is still 1500 in the column it always was.
 */

/**
 * What a pool resolves to when the catalogue says nothing at all.
 *
 * Kilograms rather than the unit table's 'piece' default, deliberately: this is the
 * unit this module used for every pooled product before it could read the real one,
 * so a product whose data says nothing keeps behaving exactly as it does today
 * instead of silently changing what an existing number means. It is a fallback for
 * missing data, not a statement about the product -- the fix for anything landing
 * here is to author its Measure Value.
 */
export const DEFAULT_POOL_UNIT = 'kg';

/**
 * The pool's display unit, from the same measurements the stock maths uses.
 *
 * `resolvePoolMeasure` is the authoritative answer -- the same one the pool is
 * divided by. When no variant's option carries a Measure Value it returns null
 * (there is nothing to divide by), and the pool falls back to DEFAULT_POOL_UNIT.
 * A unit with no magnitude cannot exist any more: the only source is the option,
 * and an option without a value resolves to EMPTY_MEASURE.
 */
export function resolvePoolUnitCode(measures: ReadonlyMap<string, VariantMeasure>): string {
    const pool = resolvePoolMeasure(measures);
    return pool ? displayUnitForBase(pool.baseUnit) : DEFAULT_POOL_UNIT;
}

/** True when a pool is weighed, i.e. the only case the old weightKg/weightGrams inputs fit. */
export function isWeightPoolUnit(unitCode: string | null | undefined): boolean {
    return (STOCK_UNITS[unitCode ?? ''] ?? STOCK_UNITS[DEFAULT_POOL_UNIT]).baseUnit === 'g';
}

/**
 * Short suffix printed beside a pool figure on a document or a screen.
 *
 * Mirrors pool-measure's `poolUnitLabel` but keyed by the DISPLAY code this module
 * passes around rather than by a base unit, so callers holding a line's stored
 * `poolUnit` do not each convert back to a base first.
 */
export function poolUnitSuffix(unitCode: string | null | undefined): string {
    const unit = STOCK_UNITS[unitCode ?? ''] ?? STOCK_UNITS[DEFAULT_POOL_UNIT];
    switch (unit.baseUnit) {
        case 'g':
            return 'kg';
        case 'ml':
            return 'L';
        default:
            return 'pcs';
    }
}

/**
 * A stored pool integer written out for a human, in its own unit.
 *
 * Deliberately NOT shared/stock-units' `formatMeasured`: that one switches unit by
 * magnitude, so 800 g of a kg-authored line prints "800 g". On a transfer document
 * every line of a load should read in one unit, and the branch weighing it out reads
 * kilograms -- so this always prints the line's own unit, and 800 g prints "0.800 kg".
 */
export function formatPoolQuantity(baseValue: number, unitCode: string | null | undefined): string {
    const unit = STOCK_UNITS[unitCode ?? ''] ?? STOCK_UNITS[DEFAULT_POOL_UNIT];
    const value = baseValue / unit.factor;
    return `${value.toFixed(unit.decimals)} ${poolUnitSuffix(unitCode)}`;
}


/**
 * The pool unit of many products at once — two queries regardless of how many.
 *
 * Every screen that shows a quantity needs this, and doing it per line would put a
 * pair of queries behind each row of a document. resolveVariantMeasures is built to
 * be handed a whole batch, so the only work here is splitting its answer back out
 * per product.
 *
 * Deliberately a plain function rather than an @Injectable, for the same reason
 * resolveVariantMeasures is one: it is wanted by the transfer service and by the
 * report service, and making it a service would either force a circular dependency
 * between those two or a third provider existing only to hold four lines.
 */
export async function poolUnitsForProducts(
    ctx: RequestContext,
    connection: TransactionalConnection,
    productIds: ID[],
): Promise<Map<string, string>> {
    const units = new Map<string, string>();
    if (!productIds.length) {
        return units;
    }
    const variants = await connection.getRepository(ctx, ProductVariant).find({
        // Deleted variants are excluded exactly as they are in ProductStockService,
        // so the unit this module shows and the unit the pool is actually divided by
        // are decided by the same set of rows.
        where: { productId: In([...new Set(productIds.map(String))]) as any, deletedAt: IsNull() },
    });
    const measures = await resolveVariantMeasures(ctx, connection, variants);
    const byProduct = new Map<string, Map<string, VariantMeasure>>();
    for (const v of variants) {
        const key = String(v.productId);
        const own = byProduct.get(key) ?? new Map<string, VariantMeasure>();
        const measure = measures.get(String(v.id));
        if (measure) {
            own.set(String(v.id), measure);
        }
        byProduct.set(key, own);
    }
    for (const id of productIds) {
        units.set(String(id), resolvePoolUnitCode(byProduct.get(String(id)) ?? new Map()));
    }
    return units;
}

/**
 * Fill in the pool unit on any line that has no snapshot of its own.
 *
 * Every line written before the column existed carries null, which is most of what
 * is in the system on the day this ships — including drafts people are part way
 * through. Falling back to a constant would mean kilograms, and kilograms is exactly
 * the wrong answer for the counted products this exists to fix, so the product is
 * asked instead.
 *
 * Applied where lines are read for DISPLAY — documents, the loading sheet, the
 * expiry screen — so every surface says the same thing about the same line. The
 * value is not written back: a snapshot belongs to the moment a line was saved, and
 * inventing one at read time would date it wrong.
 */
export async function fillPoolUnits<
    T extends { productId: ID; isPooled: boolean; poolUnit: string | null },
>(ctx: RequestContext, connection: TransactionalConnection, lines: T[]): Promise<T[]> {
    const missing = lines.filter(l => l.isPooled && l.poolUnit == null).map(l => l.productId);
    if (!missing.length) {
        return lines;
    }
    const units = await poolUnitsForProducts(ctx, connection, missing);
    for (const line of lines) {
        if (line.isPooled && line.poolUnit == null) {
            line.poolUnit = units.get(String(line.productId)) ?? DEFAULT_POOL_UNIT;
        }
    }
    return lines;
}
