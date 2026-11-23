import { describe, expect, it } from 'vitest';

import { computeAgeDays, evaluateExpiry, minExpiryDays } from '../report.helpers';

const d = (s: string) => new Date(s);

describe('computeAgeDays', () => {
    it('counts whole days, floors, never negative', () => {
        expect(computeAgeDays(d('2026-07-01T00:00:00'), d('2026-07-26T00:00:00'))).toBe(25);
        expect(computeAgeDays(d('2026-07-01T00:00:00'), d('2026-07-01T23:00:00'))).toBe(0);
        expect(computeAgeDays(d('2026-07-10T00:00:00'), d('2026-07-01T00:00:00'))).toBe(0);
    });
});

describe('evaluateExpiry (Q4 80% rule)', () => {
    it('null when no shelf life configured', () => {
        expect(evaluateExpiry(d('2026-07-01'), d('2026-07-26'), null)).toBeNull();
        expect(evaluateExpiry(d('2026-07-01'), d('2026-07-26'), 0)).toBeNull();
    });
    it('flags at/after 80% of shelf life', () => {
        // 30-day shelf life, threshold = ceil(24) = 24 days
        const before = evaluateExpiry(d('2026-07-01T00:00:00'), d('2026-07-23T00:00:00'), 30); // 22 days
        expect(before?.expireSoon).toBe(false);
        const at = evaluateExpiry(d('2026-07-01T00:00:00'), d('2026-07-25T00:00:00'), 30); // 24 days
        expect(at?.expireSoon).toBe(true);
        expect(at?.thresholdDays).toBe(24);
        const past = evaluateExpiry(d('2026-07-01T00:00:00'), d('2026-08-05T00:00:00'), 30); // 35 days
        expect(past?.expireSoon).toBe(true);
    });
    it('custom threshold', () => {
        const r = evaluateExpiry(d('2026-07-01T00:00:00'), d('2026-07-06T00:00:00'), 10, 50); // 5 of 10, threshold 5
        expect(r?.expireSoon).toBe(true);
    });
});

describe('minExpiryDays (pool = earliest-warning)', () => {
    it('takes the smallest positive, ignores null/0', () => {
        expect(minExpiryDays([30, 25, 40])).toBe(25);
        expect(minExpiryDays([null, 0, 15])).toBe(15);
        expect(minExpiryDays([null, 0])).toBeNull();
        expect(minExpiryDays([])).toBeNull();
    });
});
