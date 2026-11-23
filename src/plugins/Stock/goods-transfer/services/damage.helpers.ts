import { DamageState } from '../types';
import { resolvePoolBase } from './goods-transfer.helpers';
import { DEFAULT_POOL_UNIT, poolUnitSuffix } from './pool-unit.helper';

/**
 * Pure, framework-free damage helpers (TDS §11/§21 — unit-testable without DB).
 */

/**
 * Damage % = (damaged / received) × 100, rounded to 2 decimals.
 * Returns a string (matches the decimal(5,2) column) e.g. "8.00".
 *
 * Display value only. The photo rule (GT-11) compares numbers via
 * isPhotoMandatory rather than parsing this back, so rounding can never
 * decide whether evidence is required.
 */
export function computeDamagePercent(damaged: number, received: number): string {
    if (received <= 0) {
        return '0.00';
    }
    const pct = (damaged / received) * 100;
    return (Math.round(pct * 100) / 100).toFixed(2);
}

/** GT-11 threshold: at or above this percentage of a line, a photo is required. */
export const DAMAGE_PHOTO_THRESHOLD_PCT = 5;

/**
 * GT-11: does this line need photographic evidence?
 *
 * The rule is per LINE, not per request. A request covering a 2% loss and a 20% loss
 * needs a photo of the 20% line specifically — a request-level check would be
 * satisfied by photographing the trivial one, and a request-level percentage would
 * let a large loss on one product be diluted by intact quantities of the others.
 *
 * Compared on raw numbers, not on computeDamagePercent's rounded string: a line at
 * 4.999% rounds to "5.00" for display, and display rounding must not be what decides
 * whether evidence is mandatory.
 */
export function isPhotoMandatory(damaged: number, received: number): boolean {
    if (received <= 0 || damaged <= 0) {
        return false;
    }
    return (damaged / received) * 100 >= DAMAGE_PHOTO_THRESHOLD_PCT;
}

/** One line of a damage request, as far as the photo rule is concerned. */
export interface PhotoCheckLine {
    lineId: string | number;
    productName: string;
    damaged: number;
    received: number;
    photoCount: number;
}

/** A line that crossed the threshold with no photo attached. */
export interface MissingPhotoLine {
    lineId: string | number;
    productName: string;
    /** Display percentage of the line, e.g. "20.00". */
    percent: string;
}

/**
 * GT-11: every line of a request that requires a photo and has none.
 *
 * An empty array means the request may be submitted. Returning the offending lines
 * rather than a bare boolean is deliberate — the caller can name each product in the
 * error, so someone with a ten-line claim is told which product to photograph instead
 * of being refused without explanation.
 */
export function findLinesMissingPhoto(lines: PhotoCheckLine[]): MissingPhotoLine[] {
    return lines
        .filter(line => isPhotoMandatory(line.damaged, line.received) && line.photoCount <= 0)
        .map(line => ({
            lineId: line.lineId,
            productName: line.productName,
            percent: computeDamagePercent(line.damaged, line.received),
        }));
}

/**
 * V1 cumulative cap: for a product in a transfer, the total damaged quantity
 * across ALL pending + approved requests must never exceed the received qty.
 *
 * @param alreadyClaimed sum of damaged qty from PENDING_APPROVAL + APPROVED requests for this line
 * @param newAmount      the amount being added now
 * @param received       the received quantity of the line (basis)
 */
export function checkDamageCap(
    alreadyClaimed: number,
    newAmount: number,
    received: number,
): { ok: boolean; remaining: number; message?: string } {
    const remaining = received - alreadyClaimed;
    if (newAmount > remaining) {
        return {
            ok: false,
            remaining,
            message:
                `Damage exceeds the received quantity: ${alreadyClaimed} already claimed (pending + approved) ` +
                `+ ${newAmount} new > ${received} received. Only ${remaining} remaining.`,
        };
    }
    return { ok: true, remaining: remaining - newAmount };
}

/** States that count toward the V1 cap (a draft is not yet a claim). */
export const CLAIMED_DAMAGE_STATES = [DamageState.PendingApproval, DamageState.Approved];

/**
 * Validates the damage quantity input against the line's unit (XOR, matches the
 * line: PCS line → damagedPcs; pool line → damagedPoolQty).
 *
 * A pool claim is made in the line's OWN unit, by the same rule and the same
 * converter the transfer line uses (SPEC §6): whoever received 30 lemons claims
 * against 30 lemons, and whoever received 12.5 kg claims in kilograms. damagedKg and
 * damagedGrams remain for weighed lines and are refused on any other pool, exactly
 * as on the transfer line — a claim silently multiplied by a thousand would deduct a
 * branch's entire shelf.
 *
 * `amount` always comes back in the line's stored BASE unit, so every caller
 * downstream (cap check, percentage, stock deduction) keeps working on one number.
 */
export function validateDamageQuantity(
    isPooled: boolean,
    damagedPcs: number | null | undefined,
    damagedGrams: number | null | undefined,
    damagedKg?: number | null,
    damagedPoolQty?: number | null,
    poolUnit?: string | null,
): { ok: true; amount: number } | { ok: false; error: string } {
    const isPos = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
    if (isPooled) {
        const unit = poolUnit ?? DEFAULT_POOL_UNIT;
        const suffix = poolUnitSuffix(unit);
        const pool = resolvePoolBase(
            { poolQty: damagedPoolQty, weightGrams: damagedGrams, weightKg: damagedKg },
            unit,
        );
        if (!pool.ok) {
            // resolvePoolBase names the transfer line's own fields; this flow sends
            // the damage ones, and an error pointing at a field the request never
            // had sends whoever reads it looking in the wrong place.
            return {
                ok: false,
                error: pool.error
                    .replace(/poolQty/g, 'damagedPoolQty')
                    .replace(/weightKg/g, 'damagedKg')
                    .replace(/weightGrams/g, 'damagedGrams'),
            };
        }
        if (pool.base === null) {
            return {
                ok: false,
                error: `This is a pool product measured in ${suffix} — enter a positive damagedPoolQty`,
            };
        }
        if (damagedPcs != null) {
            return { ok: false, error: 'Do not provide damagedPcs for a pool product' };
        }
        return { ok: true, amount: pool.base };
    }
    if (!isPos(damagedPcs)) {
        return { ok: false, error: 'This is a PCS product — enter a positive damagedPcs' };
    }
    if (damagedGrams != null || damagedKg != null || damagedPoolQty != null) {
        return { ok: false, error: 'Do not provide a pool quantity for a PCS product' };
    }
    return { ok: true, amount: damagedPcs as number };
}
