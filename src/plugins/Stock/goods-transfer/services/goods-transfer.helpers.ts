import { STOCK_UNITS, toBase, toGrams } from '../../shared/stock-units';
import { TransferState } from '../types';
import { DEFAULT_POOL_UNIT, isWeightPoolUnit, poolUnitSuffix } from './pool-unit.helper';

/**
 * Pure, framework-free helpers — unit-testable without a database.
 */

/**
 * The one forward step allowed from each state (GT-06). Nothing moves backwards.
 *
 * Typed as Record<TransferState, …> on purpose: adding a state to the enum without
 * deciding what follows it is a compile error, not a runtime surprise.
 */
const TRANSFER_TRANSITIONS: Record<TransferState, TransferState | null> = {
    // Sent to the branch being asked, which is when it stops being private.
    [TransferState.RequestDraft]: TransferState.Requested,
    // Accepted by the source, which is what saving an edit on it means.
    [TransferState.Requested]: TransferState.Draft,
    [TransferState.Draft]: TransferState.Confirmed,
    [TransferState.Confirmed]: TransferState.Dispatched,
    [TransferState.Dispatched]: TransferState.Received,
    [TransferState.Received]: null, // terminal — stock is written
};

/**
 * Returns an error message when `current` is not in `allowed`, else null.
 * The service layer wraps non-null results in IllegalOperationError.
 */
export function transferStateError(
    current: TransferState,
    allowed: TransferState[],
    action: string,
): string | null {
    if (allowed.includes(current)) {
        return null;
    }
    return `Cannot ${action}: transfer is ${current} (allowed: ${allowed.join(', ')})`;
}

/** Validates a forward transition (defense-in-depth alongside transferStateError). */
export function isValidTransition(from: TransferState, to: TransferState): boolean {
    return TRANSFER_TRANSITIONS[from] === to;
}

// ---------------------------------------------------------------------------
// Line input validation (Q3a — confirmed):
//   POOL product  (productStockEnabled=ON) -> PRODUCT-level entry, poolQty only
//   PCS  product  (pool OFF)               -> VARIANT-level entry, quantityPcs only
//
// A pool is not necessarily a weight. `poolQty` is the quantity in whatever unit the
// product's own measurement option is authored in, and the pool unit travels with it
// so the conversion to the stored base integer has no special cases. weightKg and
// weightGrams remain for weighed products and are REFUSED on any other pool — an
// older client that still sends kilograms for a product counted in pieces gets a
// message rather than a pool 1000x too large.
// ---------------------------------------------------------------------------

export interface RawLineInput {
    /**
     * Id of a line already on this transfer. Present means "change this row's
     * quantity"; absent means "add a new row".
     *
     * The product on an existing row never changes — id and product together are a
     * contradiction, not a move. Anything already pointing at that row (a damage
     * claim, an audit entry) would otherwise start naming a different product.
     */
    id?: string | number | null;
    productId?: string | number | null;
    productVariantId?: string | number | null;
    quantityPcs?: number | null;
    weightGrams?: number | null;
    /** Kilograms — the everyday unit. Converted to integer grams on the way in. */
    weightKg?: number | null;
    /**
     * The pool quantity in the product's OWN unit — 1.5 for 1.5 kg, 30 for 30 pieces.
     *
     * The unit-agnostic way to send a pool line, and the only one that works for a
     * product that is not weighed. The caller never states the unit: it belongs to
     * the product, comes back on DestinationProduct.poolUnit, and is resolved again
     * server-side before this value is converted.
     */
    poolQty?: number | null;
}

export interface NormalizedLine {
    isPooled: boolean;
    productId: string | number;
    productVariantId: string | number | null;
    quantityPcs: number | null;
    /** Integer in the pool's base unit — see GoodsTransferLine.weightGrams. */
    weightGrams: number | null;
    /** The unit that base integer is in; null on a PCS line. */
    poolUnit: string | null;
}

export type LineValidation = { ok: true; value: NormalizedLine } | { ok: false; error: string };

/**
 * Upper bounds per line. Both stock columns are 32-bit ints, so a value near
 * 2^31 would overflow once it is added to whatever the destination already holds.
 * These caps sit far above any real branch transfer and turn a silent corruption
 * into a plain message.
 */
export const MAX_QUANTITY_PCS = 1_000_000;
export const MAX_WEIGHT_GRAMS = 100_000_000; // 100 tonnes
/** The same ceiling expressed in the unit most callers type. */
export const MAX_WEIGHT_KG = MAX_WEIGHT_GRAMS / 1000;
/**
 * The same ceiling for a pool stored in base units. Shared by every pool unit
 * because the reason for it is the 32-bit column, not the physical quantity — 100
 * million grams and 100 million lemons overflow the same way.
 */
export const MAX_POOL_BASE = MAX_WEIGHT_GRAMS;

function isPositiveInt(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export type WeightResolution =
    | { ok: true; grams: number | null }
    | { ok: false; error: string };

/**
 * Resolve the weight a caller sent — kilograms OR grams — to the integer grams
 * the column stores (SPEC §6).
 *
 * BOTH units are accepted on purpose. This catalogue runs from a 50 g spice
 * pouch to a 50 kg rice sack, and a single unit makes one end of that range
 * unpleasant to type: kg-only turns 50 g into 0.05, grams-only turns 50 kg into
 * 50000. Whichever the branch reads off the scale is what they may send.
 *
 * Grams pass straight through. Kilograms are the fractional unit, so they
 * convert with the same round-half-up rule Vendure uses for money — the store
 * stays integer, so repeated add/deduct can never drift.
 *
 * Returns grams: null when no weight was sent at all. That is a legitimate
 * state here (a PCS line carries none); deciding whether it is an error is the
 * caller's job, because only the caller knows the product kind.
 *
 * `names` puts the CALLER's own field names in the error text — the damage flow
 * sends damagedKg / damagedGrams, and an error naming weightKg would point at a
 * field that request never had.
 */
export function resolveWeightGrams(
    raw: { weightGrams?: number | null; weightKg?: number | null },
    names: { kg: string; grams: string } = { kg: 'weightKg', grams: 'weightGrams' },
): WeightResolution {
    const hasGrams = raw.weightGrams !== null && raw.weightGrams !== undefined;
    const hasKg = raw.weightKg !== null && raw.weightKg !== undefined;

    if (hasGrams && hasKg) {
        return { ok: false, error: `Provide either ${names.kg} OR ${names.grams} — not both` };
    }
    if (!hasGrams && !hasKg) {
        return { ok: true, grams: null };
    }

    if (hasKg) {
        const kg = raw.weightKg as number;
        if (typeof kg !== 'number' || !Number.isFinite(kg) || kg <= 0) {
            return { ok: false, error: `${names.kg} must be a positive number, e.g. 1.5` };
        }
        if (kg > MAX_WEIGHT_KG) {
            return { ok: false, error: `${names.kg} must not exceed ${MAX_WEIGHT_KG} kg (100 tonnes) on one line` };
        }
        const grams = toGrams(kg);
        // 0.0004 kg rounds to 0 g. Reporting it in kg keeps the message in the
        // unit the caller actually typed rather than the one we store.
        if (grams < 1) {
            return {
                ok: false,
                error: `${names.kg} ${kg} is under one gram — the smallest weight that can be recorded is 0.001 kg`,
            };
        }
        return { ok: true, grams };
    }

    if (!isPositiveInt(raw.weightGrams)) {
        return { ok: false, error: `${names.grams} must be a positive whole number (grams)` };
    }
    if ((raw.weightGrams as number) > MAX_WEIGHT_GRAMS) {
        return {
            ok: false,
            error: `${names.grams} must not exceed ${MAX_WEIGHT_GRAMS} (100 tonnes) on one line`,
        };
    }
    return { ok: true, grams: raw.weightGrams as number };
}

export type PoolResolution =
    | { ok: true; base: number | null }
    | { ok: false; error: string };

/**
 * Resolve whatever pool quantity a caller sent to the integer the column stores.
 *
 * Three accepted spellings, and which are legal depends on the product:
 *
 *   poolQty      always — the quantity in the product's own unit
 *   weightKg     weighed products only
 *   weightGrams  weighed products only
 *
 * The last two are refused outright on a counted or volume pool instead of being
 * reinterpreted. That refusal is the point of this function: before it, a client
 * that knew only about kilograms sent 30 for thirty lemons, it was multiplied by a
 * thousand, and 30,000 went into a pool that counts fruit. Silence there is far
 * worse than an error, because nothing downstream can tell the two apart.
 *
 * Returns base: null when no quantity was sent at all — legitimate on a PCS line,
 * and the caller decides whether that is an error.
 */
export function resolvePoolBase(raw: RawLineInput, poolUnit: string): PoolResolution {
    const hasPoolQty = raw.poolQty !== null && raw.poolQty !== undefined;
    const hasGrams = raw.weightGrams !== null && raw.weightGrams !== undefined;
    const hasKg = raw.weightKg !== null && raw.weightKg !== undefined;
    const suffix = poolUnitSuffix(poolUnit);

    if (hasPoolQty && (hasGrams || hasKg)) {
        return { ok: false, error: 'Provide either poolQty OR a weight (weightKg / weightGrams) — not both' };
    }

    if (hasGrams || hasKg) {
        if (!isWeightPoolUnit(poolUnit)) {
            return {
                ok: false,
                error:
                    `this product is measured in ${suffix}, not by weight — ` +
                    `send poolQty (the quantity in ${suffix}) instead of weightKg / weightGrams`,
            };
        }
        const weight = resolveWeightGrams(raw);
        return weight.ok ? { ok: true, base: weight.grams } : { ok: false, error: weight.error };
    }

    if (!hasPoolQty) {
        return { ok: true, base: null };
    }

    const qty = raw.poolQty as number;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
        return { ok: false, error: `poolQty must be a positive number, in ${suffix}` };
    }
    const unit = STOCK_UNITS[poolUnit] ?? STOCK_UNITS[DEFAULT_POOL_UNIT];
    // A count has no fractional part to round away. Rounding one silently would turn
    // a mistyped 2.5 into 3 lemons on a document somebody signs for.
    if (unit.kind === 'counted' && !Number.isInteger(qty)) {
        return { ok: false, error: `poolQty must be a whole number of ${suffix}` };
    }
    const base = toBase(qty, poolUnit);
    if (base < 1) {
        return {
            ok: false,
            error: `poolQty ${qty} rounds to nothing — the smallest amount that can be recorded is ${1 / unit.factor} ${suffix}`,
        };
    }
    if (base > MAX_POOL_BASE) {
        return { ok: false, error: `poolQty must not exceed ${MAX_POOL_BASE / unit.factor} ${suffix} on one line` };
    }
    return { ok: true, base };
}

/**
 * Normalizes ONE raw line against the product's pool flag and, when it is pooled,
 * the unit that pool is counted in.
 *
 * XOR rule: exactly one quantity — pieces, or a pool quantity — matching the
 * product kind.
 */
export function normalizeLineInput(
    raw: RawLineInput,
    product: { id: string | number; isPooled: boolean; poolUnit?: string | null },
): LineValidation {
    const poolUnit = product.poolUnit ?? DEFAULT_POOL_UNIT;
    const pool = resolvePoolBase(raw, poolUnit);
    if (!pool.ok) {
        return { ok: false, error: pool.error };
    }
    const hasPcs = raw.quantityPcs !== null && raw.quantityPcs !== undefined;
    const hasPool = pool.base !== null;

    if (hasPcs && hasPool) {
        return { ok: false, error: 'Provide either quantityPcs OR a pool quantity (poolQty) — not both' };
    }
    if (!hasPcs && !hasPool) {
        return {
            ok: false,
            error: 'Provide quantityPcs (PCS product) or poolQty (pool product)',
        };
    }

    if (product.isPooled) {
        if (!hasPool) {
            return {
                ok: false,
                error: `This is a pool product measured in ${poolUnitSuffix(poolUnit)} — enter poolQty, not quantityPcs`,
            };
        }
        return {
            ok: true,
            value: {
                isPooled: true,
                productId: product.id,
                productVariantId: null, // product-level entry — variant auto-split (existing pool system)
                quantityPcs: null,
                weightGrams: pool.base,
                poolUnit,
            },
        };
    }

    // PCS product — variant-level entry
    if (!hasPcs) {
        return { ok: false, error: 'This is a PCS product — enter quantityPcs, not a pool quantity' };
    }
    if (!isPositiveInt(raw.quantityPcs)) {
        return { ok: false, error: 'quantityPcs must be a positive whole number' };
    }
    if ((raw.quantityPcs as number) > MAX_QUANTITY_PCS) {
        return { ok: false, error: `quantityPcs must not exceed ${MAX_QUANTITY_PCS} on one line` };
    }
    if (raw.productVariantId === null || raw.productVariantId === undefined || raw.productVariantId === '') {
        return { ok: false, error: 'productVariantId is required for PCS products' };
    }
    return {
        ok: true,
        value: {
            isPooled: false,
            productId: product.id,
            productVariantId: raw.productVariantId,
            quantityPcs: raw.quantityPcs as number,
            weightGrams: null,
            poolUnit: null,
        },
    };
}

// ------------------------------------------------------------------ line diff

/** The subset of a persisted line the diff needs — keeps this pure and DB-free. */
export interface ComparableLine {
    productId: string | number;
    productVariantId: string | number | null;
    isPooled: boolean;
    productName: string;
    sku: string;
    quantityPcs: number | null;
    weightGrams: number | null;
    poolUnit?: string | null;
}

export interface DiffEntry {
    productName: string;
    sku: string;
    /** The line's stored quantity — base units when pooled, pieces otherwise. */
    quantity: number;
    /**
     * What that number counts, carried so the audit JSON is readable on its own.
     * A bare "30" in a trail somebody consults months later is not a quantity.
     */
    unit: string;
}

export interface QuantityChange {
    productName: string;
    sku: string;
    from: number;
    to: number;
    unit: string;
}

export interface LineDiff {
    added: DiffEntry[];
    removed: DiffEntry[];
    quantityChanged: QuantityChange[];
}

/**
 * Identity of a line: a pooled product is entered once at product level, a PCS
 * product once per variant. Two lines are "the same line" when these match — which
 * is the same rule buildLines uses to reject duplicates.
 */
function lineKey(line: ComparableLine): string {
    return line.isPooled ? `p:${line.productId}` : `v:${line.productVariantId ?? ''}`;
}

function lineQuantity(line: ComparableLine): number {
    return line.isPooled ? line.weightGrams ?? 0 : line.quantityPcs ?? 0;
}

/** The base unit the number above is in, spelled the way the trail should read. */
function lineUnit(line: ComparableLine): string {
    if (!line.isPooled) {
        return 'pcs';
    }
    const unit = STOCK_UNITS[line.poolUnit ?? ''] ?? STOCK_UNITS[DEFAULT_POOL_UNIT];
    return unit.baseUnit === 'piece' ? 'pcs' : unit.baseUnit;
}

/**
 * What changed between two versions of a transfer's line set.
 *
 * Used when the source edits a transfer that the destination has already been told
 * about: the destination is holding a document (and possibly preparing space), so
 * "it changed" is not enough — they need to know a product was added, dropped, or
 * re-weighed. The result is stored on the audit entry and summarised into the
 * notification title.
 */
export function diffTransferLines(before: ComparableLine[], after: ComparableLine[]): LineDiff {
    const beforeByKey = new Map(before.map(l => [lineKey(l), l]));
    const afterByKey = new Map(after.map(l => [lineKey(l), l]));

    const added: DiffEntry[] = [];
    const removed: DiffEntry[] = [];
    const quantityChanged: QuantityChange[] = [];

    for (const [key, line] of afterByKey) {
        const previous = beforeByKey.get(key);
        if (!previous) {
            added.push({
                productName: line.productName,
                sku: line.sku,
                quantity: lineQuantity(line),
                unit: lineUnit(line),
            });
            continue;
        }
        const from = lineQuantity(previous);
        const to = lineQuantity(line);
        if (from !== to) {
            quantityChanged.push({
                productName: line.productName,
                sku: line.sku,
                from,
                to,
                unit: lineUnit(line),
            });
        }
    }
    for (const [key, line] of beforeByKey) {
        if (!afterByKey.has(key)) {
            removed.push({
                productName: line.productName,
                sku: line.sku,
                quantity: lineQuantity(line),
                unit: lineUnit(line),
            });
        }
    }
    return { added, removed, quantityChanged };
}

/** True when nothing about the line set actually changed — no notification is worth sending. */
export function isEmptyDiff(diff: LineDiff): boolean {
    return diff.added.length === 0 && diff.removed.length === 0 && diff.quantityChanged.length === 0;
}

/**
 * One human sentence for the notification title, e.g.
 * "2 items added, 1 removed". Only the parts that actually changed are named.
 */
export function summariseDiff(diff: LineDiff): string {
    const parts: string[] = [];
    if (diff.added.length) {
        parts.push(`${diff.added.length} item${diff.added.length === 1 ? '' : 's'} added`);
    }
    if (diff.removed.length) {
        parts.push(`${diff.removed.length} removed`);
    }
    if (diff.quantityChanged.length) {
        parts.push(`${diff.quantityChanged.length} quantity changed`);
    }
    return parts.join(', ');
}


// ---------------------------------------------------------- shared stock base

export interface SharedLocationCandidate {
    id: string | number;
    name: string;
    /** Branch channels the location is assigned to, the default channel excluded. */
    channelCount: number;
}

/**
 * Which of the locations two branches share holds their common stock.
 *
 * A name match wins, the sender first: the base is the stock the goods were counted
 * in before they left, and the project names a branch's own location after its
 * channel ("Madurai"). Failing that, the location most branches draw from — the
 * category locations are shared too, but by fewer branches than the base itself.
 * Ties go to the lowest id, so the same transfer always pins the same location.
 *
 * Callers pass at least one candidate.
 */
export function pickSharedStockLocation<T extends SharedLocationCandidate>(
    candidates: T[],
    sourceCode: string,
    destinationCode: string,
): T {
    const norm = (s: string) => (s || '').trim().toLowerCase();
    for (const code of [sourceCode, destinationCode]) {
        const named = candidates.find(c => norm(c.name) === norm(code));
        if (named) {
            return named;
        }
    }
    return [...candidates].sort(
        (a, b) => b.channelCount - a.channelCount || Number(a.id) - Number(b.id),
    )[0];
}
