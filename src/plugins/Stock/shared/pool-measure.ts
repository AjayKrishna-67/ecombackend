import { VariantMeasure } from './measurement';

/**
 * Decides what a product's stock pool is measured in, and how much of it each
 * variant draws.
 *
 * The pool is a single integer on ProductStockLevel with no unit column, so
 * something has to say what that integer counts. That something is the option
 * group the merchant attached through Manage variants: a group authored in kg
 * gives a pool of grams, a group authored in Pieces gives a pool of pieces. The
 * unit is therefore DERIVED, never stored — which is why adding counted units
 * needs no migration and cannot reinterpret an existing weight pool.
 *
 * Before this module the pool read `VariantMeasure.grams`, which is null by
 * design for counted and volume units (there is no density table, so a packet
 * of paneer has no derivable weight). Every counted product therefore resolved
 * to "no weight", the strategy bailed to per-variant stock, and the pool sat at
 * zero forever. Reading `baseValue` instead makes the same arithmetic work in
 * whatever base the product is authored in: `floor(remaining / baseValue)` is
 * 50 kg ÷ 250 g = 200 and 500 lemons ÷ 20 per pack = 25, identically.
 *
 * Framework-free (no Vendure / NestJS / React imports) so the dashboard bundle
 * can import it — same rule as ./measurement.ts and ./stock-units.ts.
 */

/**
 * Base units in the order they win a mixed-authoring tie.
 *
 * Weight first is load-bearing, not cosmetic: it reproduces the previous
 * `hasWeight` filter exactly. Any product with at least one weight-bearing
 * variant resolves to a gram pool with only its weight variants participating —
 * which is precisely the set the old code selected. That is what makes this
 * change inert for every product that works today.
 */
const BASE_UNIT_PRECEDENCE: ReadonlyArray<VariantMeasure['baseUnit']> = ['g', 'ml', 'piece'];

export interface PoolMeasure {
    /** What one unit of the pool integer counts: a gram, a millilitre, or a piece. */
    readonly baseUnit: VariantMeasure['baseUnit'];
    /** How much of the pool one sellable unit of each variant draws, keyed by variant id. */
    readonly drawByVariantId: ReadonlyMap<string, number>;
    /**
     * Variants that carry a magnitude but in a DIFFERENT base than the pool
     * settled on, so they cannot participate. Non-empty means the product mixes
     * authoring styles — a data error worth logging, never worth guessing at.
     */
    readonly excludedVariantIds: ReadonlyArray<string>;
}

/**
 * Works out the pool's base unit and each variant's draw from already-resolved
 * variant measurements.
 *
 * Returns null when no variant carries a usable magnitude at all — the caller
 * must then leave the product on per-variant Vendure stock, exactly as before.
 * Null is the honest answer for a product whose options were never given a
 * `measureValue`: there is nothing to divide by, so there is no pool.
 */
export function resolvePoolMeasure(
    measures: ReadonlyMap<string, VariantMeasure>,
): PoolMeasure | null {
    // forEach rather than spreading `measures.entries()`: this module is compiled
    // by BOTH the NestJS build and the dashboard's lower-target one, where
    // iterating a Map iterator needs --downlevelIteration.
    const usable: Array<{ variantId: string; measure: VariantMeasure }> = [];
    measures.forEach((measure, variantId) => {
        if (measure.baseValue != null && measure.baseValue > 0) {
            usable.push({ variantId, measure });
        }
    });
    if (usable.length === 0) {
        return null;
    }
    const present = usable.map(entry => entry.measure.baseUnit);
    // First unit in precedence order that any variant actually uses. With a
    // single authoring style — which is every product in this catalogue — this
    // is simply that style's base.
    const baseUnit =
        BASE_UNIT_PRECEDENCE.find(candidate => present.indexOf(candidate) !== -1) ?? 'piece';

    const drawByVariantId = new Map<string, number>();
    const excludedVariantIds: string[] = [];
    for (const { variantId, measure } of usable) {
        if (measure.baseUnit === baseUnit) {
            drawByVariantId.set(variantId, measure.baseValue as number);
        } else {
            excludedVariantIds.push(variantId);
        }
    }
    return { baseUnit, drawByVariantId, excludedVariantIds };
}

/**
 * Why a variant cannot draw from its product's pool, phrased as something an
 * operator can act on. For the bail path only — the caller has already found no
 * usable `drawByVariantId` entry for this variant.
 *
 * Exists because absence from that map has two unrelated causes, and telling
 * them apart is what decides where the merchant has to go and fix the data:
 *
 *   - the variant was authored in a DIFFERENT base than the pool settled on, so
 *     the product mixes authoring styles -> fix the option's Measure Unit;
 *   - the variant carries no magnitude at all -> fill in its Measure Value.
 *
 * Inferring this from `measure.baseUnit` alone produced the nonsense message
 * "its base unit 'piece' differs from the pool's 'piece'". EMPTY_MEASURE
 * reports a baseUnit of 'piece' with a null baseValue, so an unmeasured
 * variant sitting in a piece pool compared equal to itself and got blamed for
 * a mismatch it did not have — sending whoever read the log to
 * check units that were already correct. `excludedVariantIds` is the
 * authoritative answer, and `resolvePoolMeasure` already computes it.
 */
export function poolExclusionReason(
    pool: PoolMeasure | null,
    variantId: string,
    measure: VariantMeasure,
): string {
    if (pool === null) {
        return 'no variant of this product carries a measureValue';
    }
    // indexOf rather than includes, for the same lower-target dashboard build
    // that shapes resolvePoolMeasure above.
    if (pool.excludedVariantIds.indexOf(variantId) !== -1) {
        return `its base unit '${measure.baseUnit}' differs from the pool's '${pool.baseUnit}'`;
    }
    return `it carries no measureValue of its own (the pool is in '${pool.baseUnit}')`;
}

/**
 * The unit code a pool should be READ and WRITTEN in by a human.
 *
 * Storage is always the base (grams, millilitres, pieces) because integers do
 * not lose precision; presentation scales up so an operator types "50" for
 * 50 kg rather than "50000". Counted units have no larger sibling to scale to,
 * so a piece pool is entered and shown as a plain count.
 */
export function displayUnitForBase(baseUnit: VariantMeasure['baseUnit']): string {
    switch (baseUnit) {
        case 'g':
            return 'kg';
        case 'ml':
            return 'litre';
        default:
            return 'piece';
    }
}

/**
 * Short suffix an operator reads beside a pool number.
 *
 * Separate from `displayUnitForBase` on purpose: that one returns a code the
 * conversion maths uses, this one returns text for a human. "pcs" rather than
 * the unit table's "Pieces" because it sits inline after a figure, where the
 * full word crowds the number it is describing.
 */
export function poolUnitLabel(baseUnit: VariantMeasure['baseUnit']): string {
    switch (baseUnit) {
        case 'g':
            return 'kg';
        case 'ml':
            return 'L';
        default:
            return 'pcs';
    }
}

/** Counted pools move in whole units; measured pools accept fractions. */
export function poolInputStep(baseUnit: VariantMeasure['baseUnit']): string {
    return baseUnit === 'piece' ? '1' : '0.001';
}
