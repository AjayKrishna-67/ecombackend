import { describe, expect, it } from 'vitest';
import { computeOccurrences, OccurrenceRule } from './compute-occurrences';

/**
 * Pure-function tests for occurrence expansion. No database, no Vendure server.
 *
 * Every assertion is written against a UTC ISO string on purpose: the entire
 * point of the `timezone` field is that 22:00 Asia/Kolkata must land in the
 * column as 16:30Z. Asserting on local formatting would pass even if the
 * conversion ran the wrong way.
 */

const RECURRING_BASE: OccurrenceRule = {
    mode: 'RECURRING',
    runAt: null,
    action: null,
    disableCron: '0 22 * * *',
    enableCron: null,
    timezone: 'Asia/Kolkata',
    activeFrom: null,
    activeUntil: null,
    isEnabled: true,
};

const ONE_OFF_BASE: OccurrenceRule = {
    mode: 'ONE_OFF',
    runAt: new Date('2026-08-01T10:00:00.000Z'),
    action: 'DISABLE',
    disableCron: null,
    enableCron: null,
    timezone: 'Asia/Kolkata',
    activeFrom: null,
    activeUntil: null,
    isEnabled: true,
};

const WINDOW_FROM = new Date('2026-08-01T00:00:00.000Z');
const WINDOW_TO = new Date('2026-08-04T00:00:00.000Z');

describe('computeOccurrences', () => {
    it('returns nothing for a paused rule', () => {
        const inputRule: OccurrenceRule = { ...RECURRING_BASE, isEnabled: false };

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences).toEqual([]);
    });

    it('returns a single occurrence for a one-off inside the window', () => {
        const actualOccurrences = computeOccurrences({
            rule: ONE_OFF_BASE,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences).toHaveLength(1);
        expect(actualOccurrences[0].dueAt.toISOString()).toBe('2026-08-01T10:00:00.000Z');
        expect(actualOccurrences[0].action).toBe('DISABLE');
    });

    it('returns nothing for a one-off scheduled after the window', () => {
        const inputRule: OccurrenceRule = {
            ...ONE_OFF_BASE,
            runAt: new Date('2026-09-01T10:00:00.000Z'),
        };

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences).toEqual([]);
    });

    it('still returns a one-off whose time already passed, so a late-created rule is not lost', () => {
        const inputRule: OccurrenceRule = {
            ...ONE_OFF_BASE,
            runAt: new Date('2026-07-30T10:00:00.000Z'),
        };

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences).toHaveLength(1);
        expect(actualOccurrences[0].dueAt.toISOString()).toBe('2026-07-30T10:00:00.000Z');
    });

    it('expands a nightly India-time pattern into the correct UTC instants', () => {
        const actualOccurrences = computeOccurrences({
            rule: RECURRING_BASE,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        const actualIsoTimes = actualOccurrences.map(occurrence => occurrence.dueAt.toISOString());

        expect(actualIsoTimes).toEqual([
            '2026-08-01T16:30:00.000Z',
            '2026-08-02T16:30:00.000Z',
            '2026-08-03T16:30:00.000Z',
        ]);
    });

    it('interleaves a disable/enable window pair in ascending order', () => {
        const inputRule: OccurrenceRule = { ...RECURRING_BASE, enableCron: '0 6 * * *' };

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: WINDOW_FROM,
            to: new Date('2026-08-02T00:00:00.000Z'),
        });

        expect(
            actualOccurrences.map(occurrence => [occurrence.dueAt.toISOString(), occurrence.action]),
        ).toEqual([
            ['2026-08-01T00:30:00.000Z', 'ENABLE'],
            ['2026-08-01T16:30:00.000Z', 'DISABLE'],
        ]);
    });

    it('drops occurrences after activeUntil', () => {
        const inputRule: OccurrenceRule = {
            ...RECURRING_BASE,
            activeUntil: new Date('2026-08-02T20:00:00.000Z'),
        };

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences.map(occurrence => occurrence.dueAt.toISOString())).toEqual([
            '2026-08-01T16:30:00.000Z',
            '2026-08-02T16:30:00.000Z',
        ]);
    });

    it('drops occurrences before activeFrom', () => {
        const inputRule: OccurrenceRule = {
            ...RECURRING_BASE,
            activeFrom: new Date('2026-08-02T00:00:00.000Z'),
        };

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences.map(occurrence => occurrence.dueAt.toISOString())).toEqual([
            '2026-08-02T16:30:00.000Z',
            '2026-08-03T16:30:00.000Z',
        ]);
    });

    it('handles a disable-only rule without tripping over the null enable pattern', () => {
        const actualOccurrences = computeOccurrences({
            rule: RECURRING_BASE,
            from: WINDOW_FROM,
            to: WINDOW_TO,
        });

        expect(actualOccurrences.every(occurrence => occurrence.action === 'DISABLE')).toBe(true);
    });

    it('hides a product for the whole of Friday in India time, crossing the UTC date boundary', () => {
        const inputRule: OccurrenceRule = {
            ...RECURRING_BASE,
            disableCron: '0 0 * * 5',
            enableCron: '0 0 * * 6',
        };
        const inputFrom = new Date('2026-08-01T00:00:00.000Z');
        const inputTo = new Date('2026-08-15T00:00:00.000Z');

        const actualOccurrences = computeOccurrences({
            rule: inputRule,
            from: inputFrom,
            to: inputTo,
        });

        //  IST   Thu ──────────┤ FRIDAY  hidden ├────────── Sat
        //                    00:00            00:00
        //                      ▲                ▲
        //                     HIDE             SHOW
        //                 0 0 * * 5        0 0 * * 6
        //                      │                │
        //  UTC   ── Thu 18:30 ─┘                └─ Fri 18:30
        //
        // Every instant lands on the *previous* UTC date. Any IST wall-clock time
        // before 05:30 does, and midnight is the deepest into that band: the cron
        // day-of-week field reads Friday while the UTC date is Thursday.
        //
        // That asymmetry is the whole reason `timezone` is handed to croner rather
        // than the time being converted to UTC before the pattern is built. A
        // convert-then-schedule approach would shift the day-of-week field too and
        // fire twenty-four hours early -- a bug invisible in UTC-configured stores
        // and permanent in this one.
        expect(
            actualOccurrences.map(occurrence => [occurrence.dueAt.toISOString(), occurrence.action]),
        ).toEqual([
            ['2026-08-06T18:30:00.000Z', 'DISABLE'], // Fri 00:00 IST
            ['2026-08-07T18:30:00.000Z', 'ENABLE'], // Sat 00:00 IST
            ['2026-08-13T18:30:00.000Z', 'DISABLE'], // Fri 00:00 IST
            ['2026-08-14T18:30:00.000Z', 'ENABLE'], // Sat 00:00 IST
        ]);
    });
});
