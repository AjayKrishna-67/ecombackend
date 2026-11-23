import { TransactionalConnection } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';

import { AssetChannelSyncService } from '../asset-channel-sync.service';

/**
 * These exercise the statement builder, which is where this service can fail
 * silently and destructively: an unscoped INSERT would turn a one-variant sync
 * into a full-catalogue scan on every single save, and a malformed `IN ()` would
 * throw on every save. Both are invisible in normal use.
 */
function buildService() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const connection = {
        rawConnection: {
            query: vi.fn((sql: string, params: unknown[]) => {
                queries.push({ sql, params });
                return Promise.resolve({ affectedRows: 1 });
            }),
        },
    } as unknown as TransactionalConnection;
    return { service: new AssetChannelSyncService(connection), queries };
}

describe('AssetChannelSyncService.syncTargets', () => {
    it('issues nothing at all when no targets are given', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({});
        expect(queries).toHaveLength(0);
    });

    // The dangerous case: an empty array must NOT degrade to "everything".
    // `IN ()` is also a MySQL syntax error, so this cannot be left to the driver.
    it('issues nothing for an empty id array rather than widening to all rows', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({ productIds: [], variantIds: [], collectionIds: [] });
        expect(queries).toHaveLength(0);
    });

    it('covers both reference paths for a variant: the assets list and featuredAssetId', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({ variantIds: [17] });
        expect(queries).toHaveLength(2);
        expect(queries.some(q => q.sql.includes('product_variant_asset'))).toBe(true);
        expect(queries.some(q => q.sql.includes('featuredAssetId'))).toBe(true);
    });

    it('scopes every statement and never emits a bare 1=1 for an id list', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({ productIds: [4, 7] });
        for (const q of queries) {
            expect(q.sql).toContain('IN (?,?)');
            expect(q.sql).not.toContain('1=1');
            expect(q.params).toEqual(['4', '7']);
        }
    });

    it('deduplicates ids so a bulk variant save does not repeat placeholders', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({ variantIds: [17, 17, 18] });
        expect(queries[0].params).toEqual(['17', '18']);
        expect(queries[0].sql).toContain('IN (?,?)');
    });

    it('only touches the entity types it was asked about', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({ collectionIds: [3] });
        expect(queries).toHaveLength(2);
        expect(queries.every(q => q.sql.includes('collection'))).toBe(true);
        expect(queries.some(q => q.sql.includes('product_variant'))).toBe(false);
    });

    // Every statement must be a pure INSERT. If a DELETE ever appears here, the
    // guard has become the thing it was written to prevent.
    it('never emits a statement that removes an asset/channel assignment', async () => {
        const { service, queries } = buildService();
        await service.syncTargets({ productIds: [1], variantIds: [2], collectionIds: [3] });
        expect(queries).toHaveLength(6);
        for (const q of queries) {
            expect(q.sql).toMatch(/^\s*INSERT IGNORE INTO/);
            expect(q.sql).not.toMatch(/\bDELETE\b/);
        }
    });

    it('survives a database error without throwing at the caller', async () => {
        const connection = {
            rawConnection: { query: vi.fn(() => Promise.reject(new Error('deadlock'))) },
        } as unknown as TransactionalConnection;
        const service = new AssetChannelSyncService(connection);
        await expect(service.syncTargets({ variantIds: [1] })).resolves.toBe(0);
    });

    it('reports how many links it created', async () => {
        const { service } = buildService();
        // 2 statements for a variant, stub returns affectedRows 1 for each.
        await expect(service.syncTargets({ variantIds: [1] })).resolves.toBe(2);
    });
});
