import { describe, expect, it } from 'vitest';
import { decideRunDisposition } from './decide-run-disposition';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const GRACE_MINUTES = 120;

function minutesBefore(minutes: number): Date {
    return new Date(NOW.getTime() - minutes * 60_000);
}

describe('decideRunDisposition', () => {
    it('runs a run that came due a minute ago', () => {
        const actual = decideRunDisposition({
            dueAt: minutesBefore(1),
            now: NOW,
            graceMinutes: GRACE_MINUTES,
        });

        expect(actual).toBe('RUN');
    });

    it('runs a run due exactly now', () => {
        const actual = decideRunDisposition({ dueAt: NOW, now: NOW, graceMinutes: GRACE_MINUTES });

        expect(actual).toBe('RUN');
    });

    it('runs a run at the last moment inside the grace window', () => {
        const actual = decideRunDisposition({
            dueAt: minutesBefore(GRACE_MINUTES),
            now: NOW,
            graceMinutes: GRACE_MINUTES,
        });

        expect(actual).toBe('RUN');
    });

    it('skips a run that fell out of the grace window', () => {
        const actual = decideRunDisposition({
            dueAt: minutesBefore(GRACE_MINUTES + 1),
            now: NOW,
            graceMinutes: GRACE_MINUTES,
        });

        expect(actual).toBe('SKIP_STALE');
    });

    it('skips a run that is not due yet, because claiming it was a mistake', () => {
        const actual = decideRunDisposition({
            dueAt: new Date(NOW.getTime() + 60_000),
            now: NOW,
            graceMinutes: GRACE_MINUTES,
        });

        expect(actual).toBe('SKIP_STALE');
    });
});
