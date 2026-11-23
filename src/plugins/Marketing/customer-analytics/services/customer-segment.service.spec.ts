import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '@vendure/core';
import { CustomerSegmentService } from './customer-segment.service';
import { RecencyThresholds } from './classify-recency';

const EXCLUDED_STATE = 'Cancelled';
const EXPORT_CAP = 50_000;
const thresholds: RecencyThresholds = { activeWithinDays: 30, atRiskUntilDays: 60 };

// Builds a service whose only DB touchpoint (rawConnection.query) is a spy returning `rows`.
function createService(rows: Array<Record<string, unknown>>) {
    const query = vi.fn().mockResolvedValue(rows);
    const connection = { rawConnection: { query } } as never;
    return { service: new CustomerSegmentService(connection), query };
}

const ctx = {
    channelId: 7,
    channel: { defaultCurrencyCode: 'INR' },
} as unknown as RequestContext;

describe('CustomerSegmentService.computeSummary', () => {
    it('binds threshold params before the single-pass derived-table params (channel, state, channel)', async () => {
        const { service, query } = createService([{ active: 1, atRisk: 2, churn: 3, never: 4 }]);
        await service.computeSummary(ctx, thresholds);
        const [sql, params] = query.mock.calls[0];
        // Summary CASE thresholds (x,x,y,y) precede the FROM; derived table binds after.
        expect(params).toEqual([30, 30, 60, 60, 7, EXCLUDED_STATE, 7]);
        expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
        expect(sql).toContain('LEFT JOIN');
        expect(sql).toContain('GROUP BY o.customerId');
    });
});

describe('CustomerSegmentService.listByState', () => {
    it('binds derived-table params, then the bucket threshold, then take/skip', async () => {
        // First query = countByState, second = selectByState. Assert the select (paginated) params.
        const { service, query } = createService([{ total: 0 }]);
        query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
        await service.listByState(ctx, 'AT_RISK', thresholds, { take: 25, skip: 50 });
        const [sql, params] = query.mock.calls[1];
        // derived (channel, state, channel), AT_RISK bucket (x=30, y=60), take, skip.
        expect(params).toEqual([7, EXCLUDED_STATE, 7, 30, 60, 25, 50]);
        expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
    });
});

describe('CustomerSegmentService.exportByState', () => {
    it('binds the single pre-grouped aggregate params, then the bucket threshold, then the cap', async () => {
        const { service, query } = createService([]);
        await service.exportByState(ctx, 'CHURN', thresholds);
        const [sql, params] = query.mock.calls[0];
        // Order: SUM currency (INR), agg JOIN channelId, agg WHERE state, outer EXISTS channelId, CHURN bucket (60), cap.
        expect(params).toEqual(['INR', 7, EXCLUDED_STATE, 7, 60, EXPORT_CAP]);
        // Placeholder count must match the param count or mysql2 binds the wrong values.
        expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
        expect(sql).toContain('c.phoneNumber');
        expect(sql).toContain('LEFT JOIN');
        expect(sql).toContain('GROUP BY o.customerId');
        expect(sql).toContain('SUM(CASE WHEN o.currencyCode = ?');
    });

    it('maps minor-unit totals to integers and a missing phone to null', async () => {
        const { service } = createService([
            {
                customerId: 1,
                firstName: 'Asha',
                lastName: 'Rao',
                emailAddress: 'asha@example.com',
                phoneNumber: null,
                lastOrderAt: '2026-05-01T00:00:00.000Z',
                orderCount: '4',
                totalOrderValue: '125000',
                daysSinceLastOrder: 42,
            },
        ]);
        const rows = await service.exportByState(ctx, 'AT_RISK', thresholds);
        expect(rows[0]).toMatchObject({
            customerId: 1,
            phoneNumber: null,
            orderCount: 4,
            totalOrderValue: 125000,
            state: 'AT_RISK',
        });
    });
});
