import { describe, expect, it } from 'vitest';

import {
    countClosedDaysBefore,
    isClosedDay,
    MarketClosureConfig,
    MAX_CLOSURE_WALK_BACK_DAYS,
    shiftIsoDate,
} from './market-closure';

/** Friday-only calendar: the standing weekly market closure. */
const fridayClosed: MarketClosureConfig = { closedWeekdays: [5], closedDates: [] };

describe('shiftIsoDate', () => {
    it('moves forwards and backwards', () => {
        expect(shiftIsoDate('2026-08-15', -1)).toBe('2026-08-14');
        expect(shiftIsoDate('2026-08-15', 1)).toBe('2026-08-16');
    });

    it('crosses a month boundary', () => {
        expect(shiftIsoDate('2026-09-01', -1)).toBe('2026-08-31');
    });
});

describe('isClosedDay', () => {
    it('matches a closed weekday', () => {
        expect(isClosedDay('2026-08-14', fridayClosed)).toBe(true);
    });

    it('leaves other weekdays open', () => {
        expect(isClosedDay('2026-08-13', fridayClosed)).toBe(false);
        expect(isClosedDay('2026-08-15', fridayClosed)).toBe(false);
    });

    it('matches an ad-hoc closed date', () => {
        const config: MarketClosureConfig = { closedWeekdays: [], closedDates: ['2026-08-15'] };
        expect(isClosedDay('2026-08-15', config)).toBe(true);
        expect(isClosedDay('2026-08-16', config)).toBe(false);
    });

    // An empty calendar must behave exactly as the plugin did before closures
    // existed. Every pre-existing rule ships with this config.
    it('treats an empty calendar as never closed', () => {
        const empty: MarketClosureConfig = { closedWeekdays: [], closedDates: [] };
        expect(isClosedDay('2026-08-14', empty)).toBe(false);
    });
});

describe('countClosedDaysBefore', () => {
    it('is zero when the preceding day is open', () => {
        expect(countClosedDaysBefore('2026-08-14', fridayClosed)).toBe(0);
    });

    it('counts a single closed day', () => {
        expect(countClosedDaysBefore('2026-08-15', fridayClosed)).toBe(1);
    });

    it('chains consecutive closures', () => {
        const config: MarketClosureConfig = { closedWeekdays: [5], closedDates: ['2026-08-15'] };
        expect(countClosedDaysBefore('2026-08-16', config)).toBe(2);
    });

    it('stops at the cap when every day is closed', () => {
        const allClosed: MarketClosureConfig = {
            closedWeekdays: [0, 1, 2, 3, 4, 5, 6],
            closedDates: [],
        };
        expect(countClosedDaysBefore('2026-08-16', allClosed)).toBe(MAX_CLOSURE_WALK_BACK_DAYS);
    });
});
