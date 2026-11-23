import { describe, it, expect } from 'vitest';
import { backoffMs, inputCouldChangePrice, mapWithConcurrency } from '../price-sync.util';
import { decideHealth, HealthThresholds } from '../price-sync-health.service';

describe('backoffMs', () => {
    it('doubles per attempt and caps at 32 min', () => {
        expect(backoffMs(1)).toBe(2 * 60_000);
        expect(backoffMs(2)).toBe(4 * 60_000);
        expect(backoffMs(3)).toBe(8 * 60_000);
        expect(backoffMs(5)).toBe(32 * 60_000);
        expect(backoffMs(10)).toBe(32 * 60_000); // capped
    });
});

describe('mapWithConcurrency', () => {
    it('runs every item exactly once', async () => {
        const seen: number[] = [];
        await mapWithConcurrency([1, 2, 3, 4, 5], 2, async n => {
            seen.push(n);
        });
        expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('never exceeds the concurrency limit in flight', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        const items = Array.from({ length: 20 }, (_, i) => i);
        await mapWithConcurrency(items, 3, async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            await Promise.resolve();
            inFlight--;
        });
        expect(maxInFlight).toBeLessThanOrEqual(3);
    });

    it('handles empty input without spawning workers', async () => {
        let called = false;
        await mapWithConcurrency([], 5, async () => {
            called = true;
        });
        expect(called).toBe(false);
    });
});

describe('decideHealth', () => {
    const thresholds: HealthThresholds = { probeThresholdMs: 150, minFreePoolPct: 40 };

    it('blocks when paused, regardless of other signals', () => {
        const d = decideHealth({ paused: true, probeMs: 1, freePoolPct: 99 }, thresholds);
        expect(d.healthy).toBe(false);
        expect(d.reason).toContain('paused');
    });

    it('blocks when the probe is slower than threshold', () => {
        const d = decideHealth({ paused: false, probeMs: 300, freePoolPct: 99 }, thresholds);
        expect(d.healthy).toBe(false);
        expect(d.reason).toContain('db slow');
    });

    it('blocks when the pool is tighter than threshold', () => {
        const d = decideHealth({ paused: false, probeMs: 10, freePoolPct: 20 }, thresholds);
        expect(d.healthy).toBe(false);
        expect(d.reason).toContain('pool tight');
    });

    it('passes when probe fast and pool roomy', () => {
        const d = decideHealth({ paused: false, probeMs: 10, freePoolPct: 80 }, thresholds);
        expect(d.healthy).toBe(true);
    });

    it('ignores the pool check when pool stats are unavailable (null)', () => {
        const d = decideHealth({ paused: false, probeMs: 10, freePoolPct: null }, thresholds);
        expect(d.healthy).toBe(true);
    });
});

describe('inputCouldChangePrice', () => {
    // The whole point: a variant edit that never mentions price must not fan a
    // re-sync across every active order. This is what ran 32 no-op batches
    // (up to 1096 orders each) on 5-6 Aug 2026 with no price changed since July.
    it('is false for an edit that touches only custom fields', () => {
        expect(inputCouldChangePrice([{ id: '17', customFields: { weight: null } }])).toBe(false);
    });

    it('is false for a stock-only edit', () => {
        expect(
            inputCouldChangePrice([{ id: '19', stockLevels: [], trackInventory: 'TRUE' }]),
        ).toBe(false);
    });

    it('is true when the default-currency price is submitted', () => {
        expect(inputCouldChangePrice([{ id: '17', price: 39500 }])).toBe(true);
    });

    it('is true when the per-currency prices list is submitted', () => {
        expect(inputCouldChangePrice([{ id: '17', prices: [{ currencyCode: 'INR', price: 1 }] }])).toBe(
            true,
        );
    });

    // A patch key present but null/zero is still a submitted price.
    it('is true for an explicitly cleared or zero price', () => {
        expect(inputCouldChangePrice([{ id: '17', price: 0 }])).toBe(true);
        expect(inputCouldChangePrice([{ id: '17', price: null }])).toBe(true);
    });

    it('is true when any one variant of a bulk save carries a price', () => {
        expect(
            inputCouldChangePrice([
                { id: '17', customFields: { weight: 500 } },
                { id: '18', price: 100 },
            ]),
        ).toBe(true);
    });

    // Fail-open cases. Skipping a REAL price change means customers check out at
    // stale prices, so anything unprovable must sync.
    it('fails open for an unknown or missing input shape', () => {
        expect(inputCouldChangePrice(undefined)).toBe(true);
        expect(inputCouldChangePrice(null)).toBe(true);
        expect(inputCouldChangePrice([])).toBe(true);
        expect(inputCouldChangePrice('17')).toBe(true);
        expect(inputCouldChangePrice({ price: 1 })).toBe(true);
    });

    it('fails open for an ID[] payload, which carries no field information', () => {
        expect(inputCouldChangePrice(['17', '18'])).toBe(true);
    });
});
