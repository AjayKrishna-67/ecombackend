import { describe, expect, it } from 'vitest';

import { MarketClosureConfig } from '../../functions/market-closure';
import {
    resolveClosureAwareWindow,
    resolveReportWindow,
    timeOfDayInZone,
} from '../report-sender.service';

/**
 * These guard a DELIVERY bug, not a formatting one. WhatsApp media is cached by
 * Meta against the URL, so two runs publishing the same key make the second
 * message re-display the first one's PDF. On 2026-08-07 three runs shared
 * `reports/2026-08-07/purchase_list-7-August-2026.pdf` and the 15:45 send showed
 * the 09:50 content. The time component is what keeps the keys apart.
 */
describe('timeOfDayInZone', () => {
    it('is HHMMSS with no separators', () => {
        expect(timeOfDayInZone(new Date('2026-08-07T10:15:02.000Z'), 'Asia/Kolkata')).toBe('154502');
    });

    it('reads the rule zone, not UTC', () => {
        const at = new Date('2026-08-07T10:15:02.000Z');
        expect(timeOfDayInZone(at, 'Asia/Kolkata')).toBe('154502');
        expect(timeOfDayInZone(at, 'UTC')).toBe('101502');
    });

    // Intl's en-GB gives "24" for midnight unless hour12 is false AND the
    // hourCycle resolves to h23; this pins the behaviour we rely on.
    it('renders midnight as 000000, not 240000', () => {
        expect(timeOfDayInZone(new Date('2026-08-06T18:30:00.000Z'), 'Asia/Kolkata')).toBe('000000');
    });

    it('zero-pads single-digit parts', () => {
        expect(timeOfDayInZone(new Date('2026-08-07T00:00:00.000Z'), 'UTC')).toBe('000000');
        expect(timeOfDayInZone(new Date('2026-08-07T09:08:07.000Z'), 'UTC')).toBe('090807');
    });

    // Two runs a few seconds apart is the real collision case: the "Run now"
    // button racing the sweep tick, both inside the same minute.
    it('separates runs in the same minute', () => {
        const a = timeOfDayInZone(new Date('2026-08-07T10:15:02.000Z'), 'Asia/Kolkata');
        const b = timeOfDayInZone(new Date('2026-08-07T10:15:44.000Z'), 'Asia/Kolkata');
        expect(a).not.toBe(b);
    });
});

/**
 * The failure these prevent is the quietest one a scheduled report has: covering
 * the wrong day. The output still looks like a plausible purchase list, so
 * nobody notices until the wrong vegetables arrive.
 *
 * A 05:00 Asia/Kolkata run fires at 23:30 UTC the PREVIOUS day. Anything that
 * derives "today" from the server clock is therefore a day out for the first
 * 5.5 hours of every Indian day.
 */
describe('resolveReportWindow', () => {
    it('resolves TODAY in the rule zone, not the server zone', () => {
        // 23:30 UTC on 5 Aug === 05:00 IST on 6 Aug.
        const at = new Date('2026-08-05T23:30:00.000Z');
        const { from, to } = resolveReportWindow('TODAY', 'Asia/Kolkata', at);
        // 6 Aug 00:00 IST === 5 Aug 18:30 UTC.
        expect(from.toISOString()).toBe('2026-08-05T18:30:00.000Z');
        expect(to.toISOString()).toBe('2026-08-06T18:29:59.999Z');
    });

    it('YESTERDAY is the previous day in the rule zone', () => {
        const at = new Date('2026-08-05T23:30:00.000Z'); // 6 Aug IST
        const { from, to } = resolveReportWindow('YESTERDAY', 'Asia/Kolkata', at);
        expect(from.toISOString()).toBe('2026-08-04T18:30:00.000Z');
        expect(to.toISOString()).toBe('2026-08-05T18:29:59.999Z');
    });

    // The same instant produces a DIFFERENT day in a different zone -- which is
    // the whole reason the rule carries a timezone.
    it('gives a different window for the same instant in UTC', () => {
        const at = new Date('2026-08-05T23:30:00.000Z');
        const { from } = resolveReportWindow('TODAY', 'UTC', at);
        expect(from.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    });

    it('covers the whole day, inclusive of the final millisecond', () => {
        const { from, to } = resolveReportWindow('TODAY', 'Asia/Kolkata', new Date('2026-08-06T06:00:00.000Z'));
        expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
    });

    // Month and year rollovers are where naive date arithmetic breaks.
    it('rolls back across a month boundary', () => {
        const at = new Date('2026-08-01T06:00:00.000Z'); // 1 Aug IST
        const { from } = resolveReportWindow('YESTERDAY', 'Asia/Kolkata', at);
        expect(from.toISOString()).toBe('2026-07-30T18:30:00.000Z'); // 31 Jul IST
    });

    it('rolls back across a year boundary', () => {
        const at = new Date('2026-01-01T06:00:00.000Z'); // 1 Jan IST
        const { from } = resolveReportWindow('YESTERDAY', 'Asia/Kolkata', at);
        expect(from.toISOString()).toBe('2025-12-30T18:30:00.000Z'); // 31 Dec IST
    });

    // A zone that actually observes DST, to prove the offset is read at the
    // instant rather than assumed constant.
    it('uses the zone offset in force at that moment, not a fixed one', () => {
        const summer = resolveReportWindow('TODAY', 'Europe/London', new Date('2026-07-15T12:00:00.000Z'));
        const winter = resolveReportWindow('TODAY', 'Europe/London', new Date('2026-01-15T12:00:00.000Z'));
        expect(summer.from.toISOString()).toBe('2026-07-14T23:00:00.000Z'); // BST, UTC+1
        expect(winter.from.toISOString()).toBe('2026-01-15T00:00:00.000Z'); // GMT, UTC+0
    });
});

/**
 * The Friday market closure. These assertions are the whole feature: what the
 * Saturday purchase list must cover so that Friday's orders are actually bought.
 *
 * 2026-08-13 is a Thursday, 14 a Friday, 15 a Saturday, 16 a Sunday.
 */
describe('resolveClosureAwareWindow', () => {
    const fridayClosed: MarketClosureConfig = { closedWeekdays: [5], closedDates: [] };
    const empty: MarketClosureConfig = { closedWeekdays: [], closedDates: [] };
    // 06:05 UTC is 11:35 Asia/Kolkata -- the real send time of the Coimbatore rule.
    const at = (isoDate: string) => new Date(`${isoDate}T06:05:00.000Z`);

    it('covers only today when nothing is closed', () => {
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', fridayClosed, at('2026-08-13'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        expect(result.from.toISOString()).toBe('2026-08-12T18:30:00.000Z');
        expect(result.to.toISOString()).toBe('2026-08-13T18:29:59.999Z');
    });

    it('reports the run day as closed on a Friday', () => {
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', fridayClosed, at('2026-08-14'));
        expect(result.closed).toBe(true);
        if (!result.closed) return;
        expect(result.reason).toContain('2026-08-14');
    });

    it('covers Friday and Saturday together on the Saturday run', () => {
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', fridayClosed, at('2026-08-15'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        // Friday 00:00 IST through Saturday 23:59:59.999 IST.
        expect(result.from.toISOString()).toBe('2026-08-13T18:30:00.000Z');
        expect(result.to.toISOString()).toBe('2026-08-15T18:29:59.999Z');
    });

    // Offset 1 needs no separate code path: the same formula picks up the
    // Thursday orders that Friday's skipped run would have carried.
    it('covers Thursday and Friday on a Saturday YESTERDAY run', () => {
        const result = resolveClosureAwareWindow('YESTERDAY', 'Asia/Kolkata', fridayClosed, at('2026-08-15'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        expect(result.from.toISOString()).toBe('2026-08-12T18:30:00.000Z');
        expect(result.to.toISOString()).toBe('2026-08-14T18:29:59.999Z');
    });

    it('chains a festival next to the weekly closure', () => {
        const config: MarketClosureConfig = { closedWeekdays: [5], closedDates: ['2026-08-15'] };
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', config, at('2026-08-16'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        expect(result.from.toISOString()).toBe('2026-08-13T18:30:00.000Z');
    });

    // An untouched calendar must produce byte-identical windows to today's code.
    it('matches resolveReportWindow exactly when the calendar is empty', () => {
        const now = at('2026-08-15');
        const closureAware = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', empty, now);
        const original = resolveReportWindow('TODAY', 'Asia/Kolkata', now);
        expect(closureAware.closed).toBe(false);
        if (closureAware.closed) return;
        expect(closureAware.from.toISOString()).toBe(original.from.toISOString());
        expect(closureAware.to.toISOString()).toBe(original.to.toISOString());
    });

    // A run just after midnight IST is still the previous day in UTC. Asking the
    // server clock which weekday it is gives a wrong-but-plausible answer.
    it('decides the run day in the rule zone, not UTC', () => {
        // 19:00 UTC on Thursday is 00:30 Friday in Asia/Kolkata -- closed.
        const result = resolveClosureAwareWindow(
            'TODAY',
            'Asia/Kolkata',
            fridayClosed,
            new Date('2026-08-13T19:00:00.000Z'),
        );
        expect(result.closed).toBe(true);
    });
});
