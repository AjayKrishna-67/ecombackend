import { describe, it, expect, vi } from 'vitest';
import { ProductVariant, StockLocation } from '@vendure/core';

// ─── Vendure core mock (Logger only; everything else real, incl. RequestContext) ─
vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
});

// Permissions are lazily required inside the service.
vi.mock('./permissions', () => ({
    bulkSyncPermission: { Permission: 'BulkSyncProducts' },
}));

import { BulkSyncService, SyncRow } from './bulk-sync.service';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeCtx(permissions: string[] = ['SuperAdmin']): any {
    return {
        activeUserId: 1,
        apiType: 'admin',
        languageCode: 'en',
        userHasPermissions: (perms: string[]) => perms.some(p => permissions.includes(p)),
    };
}

function makeChannel(id: number, code: string): any {
    return { id, code, token: code, defaultCurrencyCode: 'INR' };
}

function makeStockLocation(id: number, name = 'Madurai'): any {
    return { id, name };
}

/**
 * A ProductVariant as the service loads it: translations + product + prices +
 * stockLevels joined. Note the service reads `variant.translations` (variant-
 * level, not product) for the export name, and `variant.productVariantPrices`
 * for the current per-channel price.
 */
function makeVariant(
    id: number,
    sku: string,
    productName = 'Test Product',
    opts: {
        priceId?: number;
        pricePaise?: number;
        channelId?: number;
        stockOnHand?: number;
        stockLocationId?: number;
        shadowPrice?: number;
        hsnCode?: string | null;
    } = {},
): any {
    return {
        id,
        sku,
        deletedAt: null,
        translations: [{ languageCode: 'en', name: productName }],
        customFields: { shadowPrice: opts.shadowPrice ?? 0 },
        stockLevels:
            opts.stockLocationId !== undefined
                ? [{ id: 99, stockLocationId: opts.stockLocationId, stockOnHand: opts.stockOnHand ?? 0, stockAllocated: 0 }]
                : [],
        product: { id: id * 100, deletedAt: null, customFields: { hsnCode: opts.hsnCode ?? null } },
        productVariantPrices:
            opts.pricePaise !== undefined
                ? [{ id: opts.priceId ?? 1, price: opts.pricePaise, channelId: opts.channelId ?? 1 }]
                : [],
    };
}

function chainableQb(result: any[] = []) {
    const qb: any = {};
    for (const m of ['innerJoin', 'leftJoinAndSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy']) {
        qb[m] = vi.fn(() => qb);
    }
    qb.getMany = vi.fn().mockResolvedValue(result);
    return qb;
}

function buildService() {
    const variantQb = chainableQb([]);
    const locationQb = chainableQb([]);
    const connection: any = {
        getRepository: vi.fn((_ctx: any, entity: any) => {
            const name = entity?.name ?? String(entity);
            if (name === StockLocation.name) return { createQueryBuilder: () => locationQb };
            return { createQueryBuilder: () => variantQb }; // ProductVariant
        }),
    };
    const channelService: any = { findAll: vi.fn().mockResolvedValue({ items: [] }) };
    const productVariantService: any = { update: vi.fn().mockResolvedValue([]) };
    const productService: any = { update: vi.fn().mockResolvedValue({}) };
    const service = new BulkSyncService(connection, channelService, productVariantService, productService);
    return { service, variantQb, locationQb, connection, channelService, productVariantService, productService };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BulkSyncService', () => {
    describe('resolveChannel', () => {
        it('returns null for unknown city', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [] });
            expect(await service.resolveChannel(makeCtx(), 'Chennai')).toBeNull();
        });

        it('resolves Madurai (case-insensitive)', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            expect((await service.resolveChannel(makeCtx(), 'MADURAI'))?.id).toBe(1);
        });

        it('resolves Covai to ind-coimbatore channel', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(2, 'ind-coimbatore')] });
            expect((await service.resolveChannel(makeCtx(), 'Covai'))?.id).toBe(2);
        });

        it('resolves Salem', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(3, 'ind-salem')] });
            expect((await service.resolveChannel(makeCtx(), 'Salem'))?.id).toBe(3);
        });

        it('resolves Trichy', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(4, 'ind-trichy')] });
            expect((await service.resolveChannel(makeCtx(), 'Trichy'))?.id).toBe(4);
        });
    });

    describe('hasPermission', () => {
        it('allows SuperAdmin', () => {
            expect(buildService().service.hasPermission(makeCtx(['SuperAdmin']))).toBe(true);
        });
        it('allows BulkSyncProducts permission', () => {
            expect(buildService().service.hasPermission(makeCtx(['BulkSyncProducts']))).toBe(true);
        });
        it('denies user with no relevant permissions', () => {
            expect(buildService().service.hasPermission(makeCtx(['ReadCatalog']))).toBe(false);
        });
    });

    describe('bulkUpdate', () => {
        it('returns notFound=rows.length when channel not found', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [] });
            const result = await service.bulkUpdate(makeCtx(), 'Chennai', [{ sku: '101', price: 100, stock: 10 }]);
            expect(result.matched).toBe(0);
            expect(result.notFound).toBe(1);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('counts SKUs not in DB as notFound', async () => {
            const { service, channelService, variantQb } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([]); // no variants
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: 'FAKESKUXX', price: 100, stock: 10 }]);
            expect(result.matched).toBe(0);
            expect(result.notFound).toBe(1);
            expect(result.updated).toBe(0);
        });

        it('updates price via ProductVariantService.update when it changed', async () => {
            const { service, channelService, variantQb, productVariantService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            // current price ₹100 (10000 paise) on channel 1
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'Pomegranate', { pricePaise: 10000, channelId: 1 }),
            ]);
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 140, stock: 0 }]);
            expect(result.updated).toBe(1);
            expect(result.skipped).toBe(0);
            expect(productVariantService.update).toHaveBeenCalledWith(
                expect.anything(),
                [expect.objectContaining({ id: 10, price: 14000 })],
            );
            expect(result.changes[0]).toMatchObject({ sku: '101', oldPrice: 100, newPrice: 140, priceChanged: true });
        });

        it('skips variant when price and stock are identical', async () => {
            const { service, channelService, variantQb, locationQb, productVariantService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'Pomegranate', { pricePaise: 14000, channelId: 1, stockOnHand: 109, stockLocationId: 5 }),
            ]);
            locationQb.getMany.mockResolvedValueOnce([makeStockLocation(5)]);
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 140, stock: 109 }]);
            expect(result.updated).toBe(0);
            expect(result.skipped).toBe(1);
            expect(productVariantService.update).not.toHaveBeenCalled();
        });

        it('updates stock through the variant update input when it changed', async () => {
            const { service, channelService, variantQb, locationQb, productVariantService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'Pomegranate', { pricePaise: 14000, channelId: 1, stockOnHand: 50, stockLocationId: 5 }),
            ]);
            locationQb.getMany.mockResolvedValueOnce([makeStockLocation(5)]);
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 140, stock: 109 }]);
            expect(result.updated).toBe(1);
            expect(productVariantService.update).toHaveBeenCalledWith(
                expect.anything(),
                [expect.objectContaining({
                    id: 10,
                    stockLevels: expect.arrayContaining([expect.objectContaining({ stockLocationId: 5, stockOnHand: 109 })]),
                })],
            );
            expect(result.changes[0]).toMatchObject({ sku: '101', oldStock: 50, newStock: 109, stockChanged: true });
        });

        it('writes price via variant update when no price exists for the channel', async () => {
            const { service, channelService, variantQb, productVariantService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([makeVariant(10, '101')]); // no productVariantPrices
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 140, stock: 0 }]);
            expect(result.updated).toBe(1);
            expect(productVariantService.update).toHaveBeenCalledWith(
                expect.anything(),
                [expect.objectContaining({ id: 10, price: 14000 })],
            );
        });

        it('updates shadowPrice custom field through the variant input', async () => {
            const { service, channelService, variantQb, productVariantService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'Pomegranate', { pricePaise: 14000, channelId: 1, shadowPrice: 100 }),
            ]);
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 140, stock: 0, shadowPrice: 160 }]);
            expect(result.updated).toBe(1);
            expect(productVariantService.update).toHaveBeenCalledWith(
                expect.anything(),
                [expect.objectContaining({ customFields: expect.objectContaining({ shadowPrice: 160 }) })],
            );
        });

        it('updates hsnCode through ProductService.update once per product', async () => {
            const { service, channelService, variantQb, productService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'Pomegranate', { pricePaise: 14000, channelId: 1, hsnCode: null }),
            ]);
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 140, stock: 0, hsnCode: '8109010' }]);
            expect(result.updated).toBe(1);
            expect(productService.update).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ id: 1000, customFields: expect.objectContaining({ hsnCode: '8109010' }) }),
            );
        });

        it('converts price from rupees to paise correctly', async () => {
            const { service, channelService, variantQb, productVariantService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([makeVariant(10, '101')]);
            await service.bulkUpdate(makeCtx(), 'Madurai', [{ sku: '101', price: 99.5, stock: 0 }]);
            expect(productVariantService.update).toHaveBeenCalledWith(
                expect.anything(),
                [expect.objectContaining({ price: 9950 })],
            );
        });

        it('handles multiple SKUs with mixed outcomes', async () => {
            const { service, channelService, variantQb } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'P1', { pricePaise: 10000, channelId: 1 }), // ₹100 → will change
                makeVariant(11, '102', 'P2', { pricePaise: 27500, channelId: 1 }), // ₹275 → unchanged
            ]);
            const result = await service.bulkUpdate(makeCtx(), 'Madurai', [
                { sku: '101', price: 140, stock: 0 }, // changed
                { sku: '102', price: 275, stock: 0 }, // same
                { sku: 'FAKE', price: 100, stock: 10 }, // not found
            ]);
            expect(result.matched).toBe(2);
            expect(result.updated).toBe(1);
            expect(result.skipped).toBe(1);
            expect(result.notFound).toBe(1);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe('exportByCity', () => {
        it('returns empty array when channel not found', async () => {
            const { service, channelService } = buildService();
            channelService.findAll.mockResolvedValue({ items: [] });
            expect(await service.exportByCity(makeCtx(), 'Chennai')).toEqual([]);
        });

        it('returns export rows with price in rupees', async () => {
            const { service, channelService, variantQb, locationQb } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            variantQb.getMany.mockResolvedValueOnce([
                makeVariant(10, '101', 'Pomegranate', {
                    priceId: 99, pricePaise: 14000, channelId: 1, stockOnHand: 109, stockLocationId: 5, shadowPrice: 160, hsnCode: '8109010',
                }),
            ]);
            locationQb.getMany.mockResolvedValueOnce([makeStockLocation(5)]);
            const result = await service.exportByCity(makeCtx(), 'Madurai');
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                sku: '101',
                productName: 'Pomegranate',
                price: 140, // paise ÷ 100
                stock: 109,
                shadowPrice: 160,
                hsnCode: '8109010',
            });
        });

        it('returns shadowPrice=0, hsnCode=null and price=0 when unset', async () => {
            const { service, channelService, variantQb } = buildService();
            channelService.findAll.mockResolvedValue({ items: [makeChannel(1, 'ind-madurai')] });
            const variant = makeVariant(10, '101', 'Test');
            variant.customFields = {};
            variant.productVariantPrices = [];
            variantQb.getMany.mockResolvedValueOnce([variant]);
            const result = await service.exportByCity(makeCtx(), 'Madurai');
            expect(result[0].shadowPrice).toBe(0);
            expect(result[0].hsnCode).toBeNull();
            expect(result[0].price).toBe(0);
        });
    });
});
