/**
 * Pure, framework-free report/expiry helpers (unit-testable without DB).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days between two dates (>= 0). */
export function computeAgeDays(fromDate: Date, now: Date): number {
    const ms = now.getTime() - fromDate.getTime();
    return ms <= 0 ? 0 : Math.floor(ms / DAY_MS);
}

/**
 * "Expire Soon" rule: a stocked item is flagged once its age has reached the
 * threshold percentage of its shelf life. Default 80%. Indicator only — never
 * blocks stock or sales.
 *
 * DECIDED ON MILLISECONDS, not whole days, and that is the point of the arithmetic
 * below. It used to compare `floor(age in days)` against `ceil(0.8 × expiryDays)`,
 * and neither side can express a fraction of a day. For a ONE-day shelf life, 80% is
 * 19h 12m — but the age only became "1" after a full 24 hours, and the threshold
 * rounded up to "1" as well. The warning therefore arrived at 100% of the shelf life,
 * four hours and forty-eight minutes after the moment it was meant for. Short-life
 * goods are exactly what the warning exists for, and they were the ones it served
 * worst.
 *
 * `ageDays` and `thresholdDays` are still returned, unchanged, because they read
 * well on a screen. Only the VERDICT is exact.
 *
 * @returns null when it cannot be evaluated (no expiryDays configured).
 */
export function evaluateExpiry(
    approvedDate: Date,
    now: Date,
    expiryDays: number | null | undefined,
    thresholdPct = 80,
): {
    ageDays: number;
    thresholdDays: number;
    /** The exact age, and the exact moment the rule turns true. */
    ageMs: number;
    thresholdMs: number;
    expireSoon: boolean;
} | null {
    if (expiryDays == null || expiryDays <= 0) {
        return null;
    }
    const ageMs = Math.max(0, now.getTime() - approvedDate.getTime());
    const thresholdMs = (thresholdPct / 100) * expiryDays * DAY_MS;
    return {
        ageDays: computeAgeDays(approvedDate, now),
        thresholdDays: Math.ceil((thresholdPct / 100) * expiryDays),
        ageMs,
        thresholdMs,
        expireSoon: ageMs >= thresholdMs,
    };
}

/**
 * For a pool product (multiple weighted variants), the shelf life used for the
 * "Expire Soon" check is the SMALLEST expiryDays among its variants — earliest
 * warning is safest. Ignores null/0. Returns null if none configured.
 */
export function minExpiryDays(values: Array<number | null | undefined>): number | null {
    const valid = values.filter((v): v is number => typeof v === 'number' && v > 0);
    return valid.length ? Math.min(...valid) : null;
}

export const EXPIRE_SOON_DEFAULT_THRESHOLD_PCT = 80;
