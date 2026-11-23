import { describe, expect, it } from 'vitest';
import { assembleAnalytics } from './assemble-analytics';

describe('assembleAnalytics', () => {
    it('zeroes everything when there are no rows', () => {
        const actual = assembleAnalytics({ rows: [], distinctNudgedCarts: 0, avgTimeToOrderSeconds: 0, revenueRecoveredMinor: 0, costPerMessageMinor: 0 });
        expect(actual.totalSent).toBe(0);
        expect(actual.conversions).toBe(0);
        expect(actual.conversionRate).toBe(0);
        expect(actual.roi).toBe(0);
        expect(actual.sentByStage).toEqual([{ stage: 1, count: 0 }, { stage: 2, count: 0 }, { stage: 3, count: 0 }]);
    });

    it('sums sends and buckets them by stage', () => {
        const rows = [{ eventType: 'sent', stage: 1, count: 5 }, { eventType: 'sent', stage: 2, count: 2 }];
        const actual = assembleAnalytics({ rows, distinctNudgedCarts: 5, avgTimeToOrderSeconds: 0, revenueRecoveredMinor: 0, costPerMessageMinor: 0 });
        expect(actual.totalSent).toBe(7);
        expect(actual.sentByStage).toEqual([{ stage: 1, count: 5 }, { stage: 2, count: 2 }, { stage: 3, count: 0 }]);
    });

    it('buckets conversions by stage and computes rate from distinct nudged carts', () => {
        const rows = [
            { eventType: 'sent', stage: 1, count: 4 },
            { eventType: 'converted', stage: 1, count: 1 },
            { eventType: 'converted', stage: 2, count: 1 },
        ];
        const actual = assembleAnalytics({ rows, distinctNudgedCarts: 4, avgTimeToOrderSeconds: 1234, revenueRecoveredMinor: 0, costPerMessageMinor: 0 });
        expect(actual.conversions).toBe(2);
        expect(actual.conversionsByStage).toEqual([{ stage: 1, count: 1 }, { stage: 2, count: 1 }, { stage: 3, count: 0 }]);
        expect(actual.conversionRate).toBeCloseTo(0.5);
        expect(actual.avgTimeToOrderSeconds).toBe(1234);
    });

    it('computes cost and ROI from total sends and recovered revenue', () => {
        // 10 sends * ₹1 (100 paise) = ₹10 cost; ₹50 (5000 paise) recovered -> ROI 5x
        const rows = [{ eventType: 'sent', stage: 1, count: 10 }];
        const actual = assembleAnalytics({ rows, distinctNudgedCarts: 10, avgTimeToOrderSeconds: 0, revenueRecoveredMinor: 5000, costPerMessageMinor: 100 });
        expect(actual.totalCostMinor).toBe(1000);
        expect(actual.revenueRecoveredMinor).toBe(5000);
        expect(actual.roi).toBeCloseTo(5);
    });

    it('reports ROI 0 when cost per message is 0 (avoids divide-by-zero)', () => {
        const rows = [{ eventType: 'sent', stage: 1, count: 3 }];
        const actual = assembleAnalytics({ rows, distinctNudgedCarts: 3, avgTimeToOrderSeconds: 0, revenueRecoveredMinor: 9000, costPerMessageMinor: 0 });
        expect(actual.roi).toBe(0);
        expect(actual.totalCostMinor).toBe(0);
    });
});
