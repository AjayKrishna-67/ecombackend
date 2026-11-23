/**
 * A brand's market closure calendar.
 *
 * Closures are a fact about the world that many report rules read, which is why
 * this lives in the SettingsStore per brand rather than on each rule: one write,
 * many readers, and no copies to drift apart.
 */
export interface MarketClosureConfig {
    /** Day numbers, 0 = Sunday through 6 = Saturday. Friday is 5. */
    closedWeekdays: number[];
    /** One-off closures as YYYY-MM-DD, read in the rule's timezone. */
    closedDates: string[];
}

/** Never closed -- the behaviour every rule had before this feature existed. */
export const DEFAULT_MARKET_CLOSURE_CONFIG: MarketClosureConfig = {
    closedWeekdays: [],
    closedDates: [],
};

/**
 * A longer stretch of closures than this means the calendar is misconfigured or
 * the worker has been down for a week. Silently pulling a month of orders into
 * one purchase list is worse than under-reporting, so the walk-back stops here.
 */
export const MAX_CLOSURE_WALK_BACK_DAYS = 7;

/**
 * Shifts a YYYY-MM-DD string by whole days.
 *
 * Parsed as UTC on purpose: the string already carries the date as read in the
 * rule's zone, so re-applying an offset here would shift it a second time.
 */
export function shiftIsoDate(isoDate: string, days: number): string {
    const date = new Date(`${isoDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/** Whether the market is shut on the given day, by weekday rule or by date. */
export function isClosedDay(isoDate: string, config: MarketClosureConfig): boolean {
    if (config.closedDates.includes(isoDate)) {
        return true;
    }
    const weekday = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
    return config.closedWeekdays.includes(weekday);
}

/**
 * How many consecutive closed days sit immediately before `isoDate`.
 *
 * This is the count of runs that did not send, which is exactly how far back the
 * next open day's window has to reach to pick up their orders.
 */
export function countClosedDaysBefore(
    isoDate: string,
    config: MarketClosureConfig,
    cap: number = MAX_CLOSURE_WALK_BACK_DAYS,
): number {
    let count = 0;
    let cursor = shiftIsoDate(isoDate, -1);
    while (count < cap && isClosedDay(cursor, config)) {
        count += 1;
        cursor = shiftIsoDate(cursor, -1);
    }
    return count;
}
