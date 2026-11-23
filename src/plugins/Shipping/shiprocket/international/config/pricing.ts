import { BoxBracket, ShiprocketCourier } from '../types';

/**
 * Pure pricing helpers for the Shiprocket calculator. No IO — unit-tested in `pricing.spec.ts`.
 * All amounts are in INR unless the function name says otherwise.
 */

/**
 * Picks the box dimensions for a given cart weight: the smallest bracket whose `maxGrams` the
 * weight does not exceed. Weights above every bracket fall back to the largest one.
 */
export function selectBox(brackets: BoxBracket[], weightGrams: number): BoxBracket | undefined {
    if (!brackets || brackets.length === 0) {
        return undefined;
    }
    const sorted = [...brackets].sort((a, b) => a.maxGrams - b.maxGrams);
    return sorted.find(b => weightGrams <= b.maxGrams) ?? sorted[sorted.length - 1];
}

/** Finds a courier in the serviceability response by name (case-insensitive, trimmed). */
export function findCourierByName(
    couriers: ShiprocketCourier[],
    name: string,
): ShiprocketCourier | undefined {
    const target = (name ?? '').trim().toLowerCase();
    if (!target) {
        return undefined;
    }
    return couriers.find(c => (c.courier_name ?? '').trim().toLowerCase() === target);
}

/**
 * Base courier cost. Prefers `rate.rate` — the full estimated freight, which already includes
 * surcharges such as the Remote Area Surcharge (e.g. SRX couriers, where
 * `rate.rate = Forward Charges + surcharge`). Falls back to `rate.total` when `rate.rate` is absent
 * or non-positive (India Post couriers populate `total`, and there `total == rate.rate`).
 */
export function baseRateInr(courier: ShiprocketCourier): number {
    const rate = Number(courier.rate?.rate);
    if (Number.isFinite(rate) && rate > 0) {
        return rate;
    }
    const total = Number(courier.rate?.total);
    return Number.isFinite(total) && total > 0 ? total : 0;
}

/**
 * Estimated delivery window in days from the courier's `rate.extra_info.edd`
 * (e.g. `{ from: 10, to: 12 }`). Missing/non-numeric values come back as `null`.
 */
export function eddDays(courier: ShiprocketCourier): { from: number | null; to: number | null } {
    const edd = courier.rate?.extra_info?.edd;
    const from = Number(edd?.from);
    const to = Number(edd?.to);
    return {
        from: Number.isFinite(from) ? from : null,
        to: Number.isFinite(to) ? to : null,
    };
}

/**
 * Sum of the courier's `tariff` map values. Shiprocket returns these keyed by HSN code
 * (e.g. { "61091000": 15 }) — it is the import-duty rate, NOT a courier charge. Recorded in the
 * quote metadata for reference but NOT added to the shipping price.
 */
export function tariffTotalInr(courier: ShiprocketCourier): number {
    const tariff = courier.tariff ?? {};
    return Object.values(tariff).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * Slab markup: for every `grams` of cart weight (rounded up), add `gramsPerAmount` rupees.
 * Returns 0 when the slab size is not positive (markup disabled).
 */
export function slabMarkupInr(weightGrams: number, grams: number, gramsPerAmount: number): number {
    if (!grams || grams <= 0) {
        return 0;
    }
    return Math.ceil(weightGrams / grams) * gramsPerAmount;
}

export interface PriceInputs {
    /** Courier base cost in INR. */
    baseInr: number;
    /** Total cart weight in grams. */
    weightGrams: number;
    /** Slab size in grams. */
    grams: number;
    /** Rupees per slab. */
    gramsPerAmount: number;
    /** Flat handling fee in INR. */
    staticCharge: number;
    /** INR per 1 unit of the order currency (1 when the order is in INR). */
    fxRate: number;
}

/**
 * Final shipping price in the order currency's minor units (e.g. paise/cents):
 *   (base + slabMarkup + static) / fxRate × 100, rounded. (Import tariff is not charged.)
 */
export function computeFinalMinorUnits(inp: PriceInputs): number {
    const markup = slabMarkupInr(inp.weightGrams, inp.grams, inp.gramsPerAmount);
    const totalInr = inp.baseInr + markup + inp.staticCharge;
    const fx = inp.fxRate > 0 ? inp.fxRate : 1;
    return Math.round((totalInr / fx) * 100);
}
