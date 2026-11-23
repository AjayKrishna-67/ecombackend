import { Injectable, Logger } from '@nestjs/common';
import {
    Channel,
    ChannelService,
    Permission,
    Product,
    ProductService,
    ProductVariant,
    ProductVariantPrice,
    ProductVariantService,
    RequestContext,
    StockLocation,
    TransactionalConnection,
} from '@vendure/core';
import { In } from 'typeorm';

import { bulkSyncPermission } from './permissions';

const logCtx = 'BulkSyncPlugin';

const CITY_CHANNEL_MAP: Record<string, string> = {
    madurai: 'madurai',
    covai: 'coimbatore',
    coimbatore: 'coimbatore',
    salem: 'salem',
    trichy: 'trichy',
};

export interface SyncRow {
    sku: string;
    price: number;
    stock: number;
    shadowPrice?: number;
    hsnCode?: string | null;
}

export interface VariantChange {
    sku: string;
    productName: string;
    oldPrice: number | null;
    newPrice: number;
    oldStock: number;
    newStock: number;
    oldShadowPrice: number;
    newShadowPrice: number;
    oldHsnCode: string | null;
    newHsnCode: string | null;
    priceChanged: boolean;
    stockChanged: boolean;
    shadowChanged: boolean;
    hsnChanged: boolean;
}

export interface SyncResult {
    city: string;
    channelCode: string;
    matched: number;
    updated: number;
    skipped: number;
    notFound: number;
    errors: string[];
    changes: VariantChange[];
}

export interface ExportRow {
    sku: string;
    productName: string;
    price: number;
    stock: number;
    shadowPrice: number;
    hsnCode: string | null;
}

@Injectable()
export class BulkSyncService {
    constructor(
        private readonly connection: TransactionalConnection,
        private readonly channelService: ChannelService,
        private readonly productVariantService: ProductVariantService,
        private readonly productService: ProductService,
    ) {}

    async resolveChannel(ctx: RequestContext, city: string): Promise<Channel | null> {
        const key = city.trim().toLowerCase();
        const fragment = CITY_CHANNEL_MAP[key];
        if (!fragment) return null;
        const allChannels = await this.channelService.findAll(ctx);
        return allChannels.items.find(c => c.code.toLowerCase().includes(fragment)) ?? null;
    }

    /**
     * Build a RequestContext bound to the target channel. ProductVariantService.update()
     * sets `price` against `ctx.channelId`, and customFields/stockLevels are written
     * through the service's standard pipeline (validation, events, search-index queue).
     */
    private contextForChannel(ctx: RequestContext, channel: Channel): RequestContext {
        return new RequestContext({
            apiType: ctx.apiType,
            channel,
            languageCode: ctx.languageCode,
            session: (ctx as any).session,
            isAuthorized: ctx.activeUserId != null,
            authorizedAsOwnerOnly: false,
        });
    }

    async bulkUpdate(ctx: RequestContext, city: string, rows: SyncRow[]): Promise<SyncResult> {
        const channel = await this.resolveChannel(ctx, city);
        if (!channel) {
            return { city, channelCode: '', matched: 0, updated: 0, changes: [], skipped: 0, notFound: rows.length, errors: [`Channel not found for city: ${city}`] };
        }

        // Run all writes scoped to the target channel so per-channel price ends up on the right row.
        const channelCtx = this.contextForChannel(ctx, channel);

        const skuList = rows.map(r => r.sku);
        const rowBySku = new Map(rows.map(r => [r.sku, r]));

        // Load variants assigned to this channel — pulling the same relations the diff
        // needs (current price for this channel, stock, product, variant translations).
        // createQueryBuilder bypasses eager relations, so v.translations is joined explicitly.
        const variants = await this.connection
            .getRepository(channelCtx, ProductVariant)
            .createQueryBuilder('v')
            .innerJoin('v.channels', 'ch', 'ch.id = :channelId', { channelId: channel.id })
            .leftJoinAndSelect('v.productVariantPrices', 'pvp')
            .leftJoinAndSelect('v.stockLevels', 'sl')
            .leftJoinAndSelect('v.translations', 'vt')
            .leftJoinAndSelect('v.product', 'p')
            .where('v.sku IN (:...skus)', { skus: skuList })
            .andWhere('v.deletedAt IS NULL')
            .getMany();

        const foundSkus = new Set(variants.map(v => v.sku));
        const notFound  = skuList.filter(s => !foundSkus.has(s)).length;

        const stockLocation = await this.getChannelStockLocation(channelCtx, channel);

        let updated = 0, skipped = 0;
        const errors: string[] = [];
        const changes: VariantChange[] = [];

        // Track HSN updates so we don't re-update the same product more than once
        // (multiple variants can share a product).
        const productsUpdated = new Set<string>();

        for (const variant of variants) {
            const row = rowBySku.get(variant.sku);
            if (!row) continue;

            const newPricePaise = Math.round(row.price * 100);
            const newStock      = Math.floor(row.stock);

            const pvp           = variant.productVariantPrices?.find(p => String(p.channelId) === String(channel.id));
            const oldPricePaise = pvp ? Number(pvp.price) : null;
            const sl            = stockLocation ? variant.stockLevels?.find(s => String(s.stockLocationId) === String(stockLocation.id)) : undefined;
            const oldStock      = sl?.stockOnHand ?? 0;
            const variantCf     = (variant.customFields as { shadowPrice?: number }) ?? {};
            const oldShadowPrice = variantCf.shadowPrice ?? 0;
            const product       = (variant as any).product as Product | undefined;
            const productCf     = (product?.customFields as { hsnCode?: string | null }) ?? {};
            const oldHsnCode    = productCf.hsnCode ?? null;

            const priceChanged  = oldPricePaise !== newPricePaise;
            const stockChanged  = !!stockLocation && oldStock !== newStock;
            const shadowChanged = row.shadowPrice !== undefined && oldShadowPrice !== row.shadowPrice;
            const hsnChanged    = row.hsnCode !== undefined && oldHsnCode !== row.hsnCode;

            // Variant name (per ProductVariantTranslation), not product name.
            const productName =
                variant.translations?.find((t: any) => t.languageCode === 'en')?.name ??
                variant.translations?.[0]?.name ?? '';

            try {
                let didWrite = false;

                // ── Variant-level write: price + stockLevels + customFields.shadowPrice ──
                if (priceChanged || stockChanged || shadowChanged) {
                    const input: any = { id: variant.id };
                    if (priceChanged) input.price = newPricePaise;
                    if (stockChanged && stockLocation) {
                        input.stockLevels = [{ stockLocationId: stockLocation.id, stockOnHand: newStock }];
                    }
                    if (shadowChanged) {
                        input.customFields = { shadowPrice: row.shadowPrice };
                    }
                    await this.productVariantService.update(channelCtx, [input]);
                    didWrite = true;
                }

                // ── Product-level write: customFields.hsnCode (one product update per pId) ──
                if (hsnChanged && product && !productsUpdated.has(String(product.id))) {
                    await this.productService.update(channelCtx, {
                        id: product.id,
                        customFields: { hsnCode: row.hsnCode ?? null },
                    } as any);
                    productsUpdated.add(String(product.id));
                    didWrite = true;
                }

                if (didWrite) {
                    updated++;
                    changes.push({
                        sku: variant.sku,
                        productName,
                        oldPrice: oldPricePaise !== null ? oldPricePaise / 100 : null,
                        newPrice: newPricePaise / 100,
                        oldStock,
                        newStock,
                        oldShadowPrice,
                        newShadowPrice: row.shadowPrice ?? oldShadowPrice,
                        oldHsnCode,
                        newHsnCode: row.hsnCode ?? oldHsnCode,
                        priceChanged,
                        stockChanged,
                        shadowChanged,
                        hsnChanged,
                    });
                } else {
                    skipped++;
                }
            } catch (e: any) {
                errors.push(`SKU ${variant.sku}: ${e?.message ?? String(e)}`);
                Logger.error(`BulkSync error for SKU ${variant.sku}: ${e?.message}`, logCtx);
            }
        }

        return { city, channelCode: channel.code, matched: variants.length, updated, skipped, notFound, errors, changes };
    }

    async exportByCity(ctx: RequestContext, city: string): Promise<ExportRow[]> {
        const channel = await this.resolveChannel(ctx, city);
        if (!channel) return [];
        return this.exportForChannel(ctx, channel);
    }

    async exportAllCities(ctx: RequestContext): Promise<Record<string, ExportRow[]>> {
        const allChannels = await this.channelService.findAll(ctx);
        const result: Record<string, ExportRow[]> = {};
        for (const [userCity, fragment] of Object.entries(CITY_CHANNEL_MAP)) {
            if (userCity === 'coimbatore') continue;
            const channel = allChannels.items.find(c => c.code.toLowerCase().includes(fragment));
            if (!channel) continue;
            const label = userCity.charAt(0).toUpperCase() + userCity.slice(1);
            result[label] = await this.exportForChannel(ctx, channel);
        }
        return result;
    }

    private async exportForChannel(ctx: RequestContext, channel: Channel): Promise<ExportRow[]> {
        const channelCtx = this.contextForChannel(ctx, channel);
        // Load all prices/stockLevels for the variant (no join-time channel filter — we filter
        // in the mapping below). The join-condition form `leftJoinAndSelect(..., 'pvp.channelId = :id')`
        // was unreliable here: prices for other channels would slip in and `[0]` would pick the
        // wrong row, so all four city sheets exported identical values.
        const variants = await this.connection
            .getRepository(channelCtx, ProductVariant)
            .createQueryBuilder('v')
            .innerJoin('v.channels', 'ch', 'ch.id = :channelId', { channelId: channel.id })
            .leftJoinAndSelect('v.productVariantPrices', 'pvp')
            .leftJoinAndSelect('v.stockLevels', 'sl')
            .leftJoinAndSelect('v.translations', 'vt')
            .leftJoinAndSelect('v.product', 'p')
            .where('v.deletedAt IS NULL')
            .andWhere('p.deletedAt IS NULL')
            .orderBy('CAST(v.sku AS UNSIGNED)', 'ASC')
            .addOrderBy('v.sku', 'ASC')
            .getMany();

        const stockLocation = await this.getChannelStockLocation(channelCtx, channel);

        return variants.map(v => {
            const pvp = v.productVariantPrices?.find(p => String(p.channelId) === String(channel.id));
            const sl  = stockLocation ? v.stockLevels?.find(s => String(s.stockLocationId) === String(stockLocation.id)) : undefined;
            const variantCf = v.customFields as { shadowPrice?: number } | undefined;
            const productCf = v.product?.customFields as { hsnCode?: string } | undefined;
            const productName = v.translations?.find(t => t.languageCode === 'en')?.name ?? v.translations?.[0]?.name ?? '';
            return {
                sku: v.sku,
                productName,
                price: pvp ? Number(pvp.price) / 100 : 0,
                stock: sl?.stockOnHand ?? 0,
                shadowPrice: variantCf?.shadowPrice ?? 0,
                hsnCode: productCf?.hsnCode ?? null,
            };
        });
    }

    /**
     * Pick the stock_location dedicated to this channel (matched by name).
     * Several stock_locations are assigned to multiple city channels in this DB
     * (e.g. id 2 "Madurai" is assigned to all four cities). Picking the lowest id
     * would route every city's stock write to the Madurai warehouse — instead
     * prefer the one whose name matches the channel code.
     */
    private async getChannelStockLocation(ctx: RequestContext, channel: Channel): Promise<StockLocation | null> {
        const locations = await this.connection
            .getRepository(ctx, StockLocation)
            .createQueryBuilder('sl')
            .innerJoin('sl.channels', 'ch', 'ch.id = :channelId', { channelId: channel.id })
            .orderBy('sl.id', 'ASC')
            .getMany();
        if (!locations.length) return null;
        const channelKey = channel.code.toLowerCase();
        const named = locations.find(loc => {
            const n = loc.name.toLowerCase();
            return channelKey.includes(n) || n.includes(channelKey);
        });
        return named ?? locations[0];
    }

    hasPermission(ctx: RequestContext): boolean {
        return (
            ctx.userHasPermissions([Permission.SuperAdmin]) ||
            ctx.userHasPermissions([bulkSyncPermission.Permission as unknown as Permission])
        );
    }
}
