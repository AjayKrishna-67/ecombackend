import { Injectable } from '@nestjs/common';
import {
    Administrator,
    AdministratorService,
    EventBus,
    ID,
    Logger,
    Product,
    ProductVariant,
    ProductVariantEvent,
    ProductVariantService,
    RequestContext,
    StockLevel,
    StockLevelService,
    StockLocation,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In, IsNull } from 'typeorm';
import { ProductStockLevel } from '../../product-stock/entities/product-stock-level.entity';
import { ProductStockService } from '../../product-stock/services/product-stock.service';
import { STOCK_UNITS } from '../../shared/stock-units';
import { isCustomFieldTrue } from '../../shared/custom-field-boolean';
import { EMPTY_MEASURE, VariantMeasure } from '../../shared/measurement';
import { resolvePoolMeasure } from '../../shared/pool-measure';
import { resolveVariantMeasure, resolveVariantMeasures } from '../../shared/resolve-variant-measure';
import { TagMatchMode, TagService } from '../../../Essentials/tags/services/tag.service';
import { StockChangeLog } from '../entities/stock-change-log.entity';

const loggerCtx = 'LocationStockPlugin';

export interface LocationStockRow {
    variantId: ID;
    productId: ID;
    sku: string;
    name: string;
    stockUnit: string;
    baseUnit: string;
    stockOnHand: number;
    stockAllocated: number;
}

export interface ProductPoolStockRow {
    productId: ID;
    name: string;
    hasPoolHere: boolean;
    stockOnHand: number | null;
    stockAllocated: number;
}

export interface LocationStockQuery {
    stockLocationId: ID;
    tagIds?: ID[];
    matchMode?: TagMatchMode;
    search?: string;
}

export interface SetVariantStockInput {
    variantId: ID;
    stockLocationId: ID;
    stockOnHand: number;
}

export interface SetProductPoolStockInput {
    productId: ID;
    stockLocationId: ID;
    stockOnHand: number;
}

export interface StockChangeHistoryOptions {
    stockLocationId?: ID;
    kind?: string;
    targetId?: ID;
    skip?: number;
    take?: number;
}

export interface StockLogRowInput {
    kind: 'variant' | 'product-pool';
    targetId: ID;
    unit: string;
    oldOnHand: number | null;
    newOnHand: number;
    stockLocationId: ID;
}

export interface StockLogMeta {
    targetName: string;
    locationName: string;
    adminId?: ID;
    adminName: string;
}


/**
 * Pure: turns one accepted stock write into an audit row, or null when it is a
 * no-op (new === old) so the log only records real changes. Kept pure and
 * exported so it can be unit-tested without a DB (see __tests__).
 */
export function buildStockLogRow(
    input: StockLogRowInput,
    meta: StockLogMeta,
): Partial<StockChangeLog> | null {
    if (input.oldOnHand === input.newOnHand) {
        return null;
    }
    return {
        kind: input.kind,
        unit: input.unit,
        targetId: input.targetId,
        targetName: meta.targetName,
        stockLocationId: input.stockLocationId,
        locationName: meta.locationName,
        oldOnHand: input.oldOnHand,
        newOnHand: input.newOnHand,
        adminId: meta.adminId ?? null,
        adminName: meta.adminName,
    };
}

/**
 * Location-first stock editor backend. Two read paths (variant-wise vs
 * product weight-pool) and two write paths, split by the SAME classifier:
 * a product is "pooled" if it has ANY ProductStockLevel row (global per
 * product). Reads run under the DEFAULT channel so a location shows products
 * across every channel it serves; stock is per-location, not per-channel.
 *
 *   READ ─ default-channel ctx ─► partition products by pool-id Set ─► rows
 *   WRITE(variant) ─► StockLevelService.updateStockOnHandForLocation (delta)
 *   WRITE(pool)    ─► ProductStockService.setProductStock (grams, re-derives)
 *
 * Both writes append a StockChangeLog row and publish ProductVariantEvent so
 * the search index re-syncs. EventBus defers handlers until the surrounding
 * @Transaction commits, so the reindex never reads a pre-commit row.
 */
@Injectable()
export class LocationStockService {
    constructor(
        private connection: TransactionalConnection,
        private stockLevelService: StockLevelService,
        private productVariantService: ProductVariantService,
        private productStockService: ProductStockService,
        private administratorService: AdministratorService,
        private tagService: TagService,
        private eventBus: EventBus,
    ) {}

    async getVariantStock(
        ctx: RequestContext,
        query: LocationStockQuery,
    ): Promise<LocationStockRow[]> {
        const poolIds = await this.getPoolProductIds(ctx);
        const tagProductIds = await this.resolveTagProductIds(ctx, query);
        if (tagProductIds && !tagProductIds.length) {
            return [];
        }
        const qb = this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('v')
            .innerJoin('v.channels', 'channel')
            .select(['v.id', 'v.productId'])
            .where('v.deletedAt IS NULL')
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId });
        if (tagProductIds) {
            qb.andWhere('v.productId IN (:...tagProductIds)', { tagProductIds });
        }
        if (poolIds.size) {
            qb.andWhere('v.productId NOT IN (:...poolIds)', { poolIds: [...poolIds] });
        }
        const candidates = await qb.orderBy('v.productId', 'ASC').take(500).getMany();
        const variantIds = candidates.map(v => v.id);
        if (!variantIds.length) {
            return [];
        }
        const translated = await this.productVariantService.findByIds(ctx, variantIds);
        const levelMap = await this.getLevelMap(ctx, variantIds, query.stockLocationId);
        const search = query.search?.trim().toLowerCase();
        const measures = await resolveVariantMeasures(ctx, this.connection, translated);
        const rows = translated.map(v =>
            this.buildVariantRow(
                v,
                measures.get(String(v.id)) ?? EMPTY_MEASURE,
                levelMap.get(`${v.id}`),
            ),
        );
        return search
            ? rows.filter(
                  r =>
                      r.name.toLowerCase().includes(search) ||
                      r.sku.toLowerCase().includes(search),
              )
            : rows;
    }

    async getProductPoolStock(
        ctx: RequestContext,
        query: LocationStockQuery,
    ): Promise<ProductPoolStockRow[]> {
        let poolIds = [...(await this.getPoolProductIds(ctx))];
        if (!poolIds.length) {
            return [];
        }
        const tagProductIds = await this.resolveTagProductIds(ctx, query);
        if (tagProductIds) {
            const tagSet = new Set(tagProductIds.map(id => `${id}`));
            poolIds = poolIds.filter(id => tagSet.has(id));
        }
        if (!poolIds.length) {
            return [];
        }
        const products = await this.connection.getRepository(ctx, Product).find({
            where: { id: In(poolIds), deletedAt: IsNull() },
            relations: ['translations'],
        });
        const pslRows = await this.connection.getRepository(ctx, ProductStockLevel).find({
            where: { productId: In(poolIds), stockLocationId: query.stockLocationId },
        });
        const pslMap = new Map(pslRows.map(p => [`${p.productId}`, p]));
        const search = query.search?.trim().toLowerCase();
        const rows = products.map(p => {
            const psl = pslMap.get(`${p.id}`);
            return {
                productId: p.id,
                name: this.productName(p, ctx),
                hasPoolHere: !!psl,
                stockOnHand: psl ? psl.stockOnHand : null,
                stockAllocated: psl ? psl.stockAllocated : 0,
            };
        });
        return search ? rows.filter(r => r.name.toLowerCase().includes(search)) : rows;
    }

    async setVariantStockOnHand(ctx: RequestContext, input: SetVariantStockInput): Promise<boolean> {
        if (input.stockOnHand < 0) {
            throw new UserInputError('Stock on hand cannot be negative');
        }
        const variant = await this.connection
            .getRepository(ctx, ProductVariant)
            .findOne({ where: { id: input.variantId } });
        if (!variant) {
            throw new UserInputError(`Variant ${input.variantId} not found`);
        }
        const product = await this.connection
            .getRepository(ctx, Product)
            .findOne({ where: { id: variant.productId } });
        // isCustomFieldTrue, NOT `=== true`: the tinyint arrives as 1, not true.
        const pooled = isCustomFieldTrue((product?.customFields as any)?.productStockEnabled);
        if (pooled) {
            throw new UserInputError(
                'This product uses product-level pool stock — edit it in the Product Stock section.',
            );
        }
        const existing = await this.connection
            .getRepository(ctx, StockLevel)
            .findOne({ where: { productVariantId: input.variantId, stockLocationId: input.stockLocationId } });
        const oldOnHand = existing ? existing.stockOnHand : null;
        const current = existing ? existing.stockOnHand : 0;
        const change = input.stockOnHand - current;
        if (change !== 0) {
            await this.stockLevelService.updateStockOnHandForLocation(
                ctx,
                input.variantId,
                input.stockLocationId,
                change,
            );
        }
        const [name] = await this.translatedVariantNames(ctx, [input.variantId]);
        const unit = (await resolveVariantMeasure(ctx, this.connection, variant)).unit;
        await this.recordChange(
            ctx,
            {
                kind: 'variant',
                targetId: input.variantId,
                unit: STOCK_UNITS[unit]?.baseUnit ?? 'piece',
                oldOnHand,
                newOnHand: input.stockOnHand,
                stockLocationId: input.stockLocationId,
            },
            name ?? variant.sku,
        );
        await this.publishVariantUpdate(ctx, [input.variantId]);
        return true;
    }

    async setProductPoolStock(
        ctx: RequestContext,
        input: SetProductPoolStockInput,
    ): Promise<boolean> {
        if (input.stockOnHand < 0) {
            throw new UserInputError('Stock on hand cannot be negative');
        }
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .find({ where: { productId: input.productId, deletedAt: IsNull() } });
        const poolMeasures = await resolveVariantMeasures(ctx, this.connection, variants);
        // A pool needs a magnitude to divide by, in ANY base -- grams, millilitres
        // or pieces. The old guard demanded a WEIGHT, which rejected every
        // counted product outright and is why a Nos-authored pool could not be
        // created here at all.
        if (resolvePoolMeasure(poolMeasures) === null) {
            throw new UserInputError(
                'This product has no measured variants, so a stock pool would not be sellable. Set a Measure Value and Measure Unit on the options in its measurement group (Catalog > Option Groups) first.',
            );
        }
        const existing = await this.connection
            .getRepository(ctx, ProductStockLevel)
            .findOne({ where: { productId: input.productId, stockLocationId: input.stockLocationId } });
        const oldOnHand = existing ? existing.stockOnHand : null;
        await this.productStockService.setProductStock(
            ctx,
            input.productId,
            input.stockLocationId,
            input.stockOnHand,
        );
        const product = await this.connection
            .getRepository(ctx, Product)
            .findOne({ where: { id: input.productId }, relations: ['translations'] });
        await this.recordChange(
            ctx,
            {
                kind: 'product-pool',
                targetId: input.productId,
                unit: 'g',
                oldOnHand,
                newOnHand: input.stockOnHand,
                stockLocationId: input.stockLocationId,
            },
            product ? this.productName(product, ctx) : `${input.productId}`,
        );
        await this.publishVariantUpdate(ctx, variants.map(v => v.id));
        return true;
    }

    async getHistory(
        ctx: RequestContext,
        options: StockChangeHistoryOptions = {},
    ): Promise<{ items: StockChangeLog[]; totalItems: number }> {
        const qb = this.connection
            .getRepository(ctx, StockChangeLog)
            .createQueryBuilder('log')
            .orderBy('log.createdAt', 'DESC')
            .skip(options.skip ?? 0)
            .take(Math.min(options.take ?? 25, 100));
        if (options.stockLocationId) {
            qb.andWhere('log.stockLocationId = :stockLocationId', {
                stockLocationId: options.stockLocationId,
            });
        }
        if (options.kind) {
            qb.andWhere('log.kind = :kind', { kind: options.kind });
        }
        if (options.targetId) {
            qb.andWhere('log.targetId = :targetId', { targetId: options.targetId });
        }
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    /**
     * The classifier set: productIds whose `productStockEnabled` flag is ON.
     *
     * We key off the FLAG, not the presence of ProductStockLevel rows, because
     * the flag is exactly what ProductStockLocationStrategy gates on
     * (strategy:373 — toggle off ⇒ it falls through to normal per-variant
     * stock). A product can keep stale pool rows after the toggle is turned
     * off; those rows are inert and a direct variant write is then safe, so
     * such a product must live in the Variant tab.
     */
    private async getPoolProductIds(ctx: RequestContext): Promise<Set<string>> {
        const rows = await this.connection
            .getRepository(ctx, Product)
            .createQueryBuilder('product')
            .innerJoin('product.channels', 'channel')
            .select('product.id', 'id')
            .where('product.customFieldsProductstockenabled = :enabled', { enabled: true })
            .andWhere('product.deletedAt IS NULL')
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
            .getRawMany();
        return new Set(rows.map(r => `${r.id}`));
    }

    private async resolveTagProductIds(
        ctx: RequestContext,
        query: LocationStockQuery,
    ): Promise<ID[] | undefined> {
        if (!query.tagIds?.length) {
            return undefined;
        }
        const result = await this.tagService.getProductsByTag(ctx, {
            tagIds: query.tagIds,
            matchMode: query.matchMode,
        });
        return result.items.map(p => p.id);
    }

    private async getLevelMap(
        ctx: RequestContext,
        variantIds: ID[],
        stockLocationId: ID,
    ): Promise<Map<string, StockLevel>> {
        const levels = await this.connection
            .getRepository(ctx, StockLevel)
            .find({ where: { productVariantId: In(variantIds), stockLocationId } });
        return new Map(levels.map(l => [`${l.productVariantId}`, l]));
    }

    private buildVariantRow(
        variant: ProductVariant,
        measure: VariantMeasure,
        level?: StockLevel,
    ): LocationStockRow {
        const unit = measure.unit;
        return {
            variantId: variant.id,
            productId: (variant as any).productId,
            sku: variant.sku,
            name: variant.name,
            stockUnit: unit,
            baseUnit: STOCK_UNITS[unit]?.baseUnit ?? 'piece',
            stockOnHand: level ? level.stockOnHand : 0,
            stockAllocated: level ? level.stockAllocated : 0,
        };
    }

    private productName(product: Product, ctx: RequestContext): string {
        const translations = (product as any).translations ?? [];
        const match = translations.find((t: any) => t.languageCode === ctx.languageCode);
        return match?.name ?? translations[0]?.name ?? `Product #${product.id}`;
    }

    private async translatedVariantNames(ctx: RequestContext, ids: ID[]): Promise<string[]> {
        const variants = await this.productVariantService.findByIds(ctx, ids);
        return variants.map(v => v.name);
    }

    private async recordChange(
        ctx: RequestContext,
        input: StockLogRowInput,
        targetName: string,
    ): Promise<void> {
        const location = await this.connection
            .getRepository(ctx, StockLocation)
            .findOne({ where: { id: input.stockLocationId } });
        const admin = await this.resolveAdmin(ctx);
        const row = buildStockLogRow(input, {
            targetName,
            locationName: location?.name ?? `${input.stockLocationId}`,
            adminId: admin.adminId,
            adminName: admin.adminName,
        });
        if (!row) {
            return;
        }
        await this.connection.getRepository(ctx, StockChangeLog).save(new StockChangeLog(row));
        Logger.info(
            `Stock change: ${input.kind} ${input.targetId} @ loc ${input.stockLocationId} ` +
                `${input.oldOnHand ?? '∅'} -> ${input.newOnHand} ${input.unit} by ${admin.adminName}`,
            loggerCtx,
        );
    }

    private async resolveAdmin(ctx: RequestContext): Promise<{ adminId?: ID; adminName: string }> {
        if (!ctx.activeUserId) {
            return { adminName: '<unknown>' };
        }
        const admin: Administrator | undefined = await this.administratorService.findOneByUserId(
            ctx,
            ctx.activeUserId,
        );
        if (!admin) {
            return { adminName: '<unknown>' };
        }
        return { adminId: admin.id, adminName: `${admin.firstName} ${admin.lastName}`.trim() };
    }

    private async publishVariantUpdate(ctx: RequestContext, variantIds: ID[]): Promise<void> {
        if (!variantIds.length) {
            return;
        }
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .find({ where: { id: In(variantIds) } });
        if (variants.length) {
            await this.eventBus.publish(new ProductVariantEvent(ctx, variants, 'updated'));
        }
    }
}
