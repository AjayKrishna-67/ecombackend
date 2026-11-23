import { Injectable } from '@nestjs/common';
import {
    Administrator,
    AdministratorService,
    ChannelService,
    CurrencyCode,
    EventBus,
    ID,
    ListQueryOptions,
    Logger,
    Product,
    ProductVariant,
    ProductVariantEvent,
    ProductVariantService,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';
import { TagMatchMode, TagService } from '../../tags/services/tag.service';
import { PriceChangeLog } from '../entities/price-change-log.entity';

const loggerCtx = 'PriceMatrixPlugin';

export interface PriceMatrixChannelColumn {
    id: ID;
    code: string;
    currencyCode: CurrencyCode;
}

export interface PriceMatrixCell {
    channelId: ID;
    currencyCode: CurrencyCode;
    price: number | null;
    assigned: boolean;
}

export interface PriceMatrixRow {
    variantId: ID;
    productId: ID;
    name: string;
    sku: string;
    cells: PriceMatrixCell[];
}

export interface VariantPriceMatrix {
    channels: PriceMatrixChannelColumn[];
    rows: PriceMatrixRow[];
    totalItems: number;
}

export interface SetVariantChannelPriceInput {
    variantId: ID;
    channelId: ID;
    price: number;
    currencyCode?: CurrencyCode;
}

export interface PriceChangeHistoryOptions {
    variantId?: ID;
    channelId?: ID;
    adminId?: ID;
    from?: Date;
    to?: Date;
    skip?: number;
    take?: number;
}

export interface PriceChangeLogRow {
    variantId: ID;
    variantName: string;
    channelId: ID;
    channelName: string;
    oldPrice: number | null;
    newPrice: number;
    currencyCode: string;
    adminId?: ID;
    adminName: string;
}

export interface BuildLogRowsMeta {
    variantNames: Map<string, string>;
    channelNames: Map<string, string>;
    oldPrices: Map<string, number>;
    currencyByChannel: Map<string, string>;
    adminId?: ID;
    adminName: string;
}

/**
 * Pure: turns the accepted updates into audit rows. Skips no-op writes
 * (new price === prior price) so the log only records real changes.
 * Maps are keyed by string id; cell key is `${variantId}:${channelId}`.
 */
export function buildLogRows(
    updates: SetVariantChannelPriceInput[],
    meta: BuildLogRowsMeta,
): PriceChangeLogRow[] {
    const rows: PriceChangeLogRow[] = [];
    for (const update of updates) {
        const cellKey = `${update.variantId}:${update.channelId}`;
        const oldPrice = meta.oldPrices.has(cellKey) ? meta.oldPrices.get(cellKey)! : null;
        if (oldPrice === update.price) {
            continue;
        }
        rows.push({
            variantId: update.variantId,
            variantName: meta.variantNames.get(`${update.variantId}`) ?? `${update.variantId}`,
            channelId: update.channelId,
            channelName: meta.channelNames.get(`${update.channelId}`) ?? `${update.channelId}`,
            oldPrice,
            newPrice: update.price,
            currencyCode:
                update.currencyCode ?? meta.currencyByChannel.get(`${update.channelId}`) ?? '',
            adminId: meta.adminId,
            adminName: meta.adminName,
        });
    }
    return rows;
}

/**
 * Reads and writes the variant x channel price grid.
 *
 * READ ─ tags + the product set resolve in whatever channel `ctx` carries (the
 * caller MUST send the default/master channel token). Prices and channel
 * assignment are read straight off the `productVariantPrices` / `channels`
 * relations, which are NOT channel-filtered, so one variant query yields every
 * channel's price at once. No N+1.
 *
 *   getProductsByTag (reuse)         findByIds (translated names)
 *           │                                 │
 *           ▼                                 ▼
 *   product page ──► variant+prices+channels query ──► rows[variant][channel]
 *
 * WRITE ─ each cell goes through ProductVariantService.createOrUpdateProductVariantPrice
 * (the proper API, takes channelId as an arg, no per-channel ctx rebuild). That
 * method emits ProductVariantPriceEvent, which the cart-sync PriceUpdatePlugin
 * does NOT listen to — it listens for ProductVariantEvent. So after writing we
 * re-publish ProductVariantEvent('updated') ourselves to trigger cart sync.
 */
@Injectable()
export class PriceMatrixService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private productVariantService: ProductVariantService,
        private tagService: TagService,
        private eventBus: EventBus,
        private administratorService: AdministratorService,
    ) {}

    async getMatrix(
        ctx: RequestContext,
        input: { tagIds: ID[]; matchMode?: TagMatchMode; options?: ListQueryOptions<Product> },
    ): Promise<VariantPriceMatrix> {
        const allChannels = await this.getChannelColumns(ctx);
        const products = await this.tagService.getProductsByTag(ctx, {
            tagIds: input.tagIds,
            matchMode: input.matchMode,
            options: input.options,
        });
        const productIds = products.items.map(p => p.id);
        if (!productIds.length) {
            return { channels: [], rows: [], totalItems: products.totalItems };
        }
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('v')
            .leftJoinAndSelect('v.productVariantPrices', 'price')
            .leftJoinAndSelect('v.channels', 'channel')
            .where('v.productId IN (:...productIds)', { productIds })
            .andWhere('v.deletedAt IS NULL')
            .orderBy('v.productId', 'ASC')
            .addOrderBy('v.id', 'ASC')
            .getMany();
        // Columns = ONLY the channels this result set actually uses (union of
        // each variant's assigned channels), in channel display order. So a
        // 4-channel tag shows 4 columns even when the system has 10 channels.
        // A variant not assigned to a used column renders a locked "not sold"
        // cell (assigned=false) — that keeps the table rectangular while still
        // reflecting each product's real channel set.
        const usedIds = new Set<string>();
        for (const variant of variants) {
            for (const channel of variant.channels ?? []) {
                usedIds.add(`${channel.id}`);
            }
        }
        const channels = allChannels.filter(
            c => usedIds.has(`${c.id}`) && c.code !== '__default_channel__',
        );
        const names = await this.getVariantNames(ctx, variants.map(v => v.id));
        const rows = variants.map(variant => this.buildRow(variant, channels, names));
        return { channels, rows, totalItems: products.totalItems };
    }

    async getHistory(
        ctx: RequestContext,
        options: PriceChangeHistoryOptions = {},
    ): Promise<{ items: PriceChangeLog[]; totalItems: number }> {
        const qb = this.connection
            .getRepository(ctx, PriceChangeLog)
            .createQueryBuilder('log')
            .orderBy('log.createdAt', 'DESC')
            .skip(options.skip ?? 0)
            .take(Math.min(options.take ?? 25, 100));
        if (options.variantId) {
            qb.andWhere('log.variantId = :variantId', { variantId: options.variantId });
        }
        if (options.channelId) {
            qb.andWhere('log.channelId = :channelId', { channelId: options.channelId });
        }
        if (options.adminId) {
            qb.andWhere('log.adminId = :adminId', { adminId: options.adminId });
        }
        if (options.from) {
            qb.andWhere('log.createdAt >= :from', { from: options.from });
        }
        if (options.to) {
            qb.andWhere('log.createdAt <= :to', { to: options.to });
        }
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    async setPrices(
        ctx: RequestContext,
        updates: SetVariantChannelPriceInput[],
    ): Promise<{ updatedCount: number; variantIds: ID[] }> {
        if (!updates.length) {
            return { updatedCount: 0, variantIds: [] };
        }
        const channelColumns = await this.getChannelColumns(ctx);
        const channelCurrency = new Map(channelColumns.map(c => [`${c.id}`, c.currencyCode]));
        const channelNames = new Map(channelColumns.map(c => [`${c.id}`, c.code]));
        const { assignment, oldPrices } = await this.loadWriteState(ctx, updates);
        this.assertAllAssigned(assignment, updates);
        const variantNamesMeta = await this.getVariantNames(
            ctx,
            [...new Set(updates.map(u => u.variantId))],
        );
        const variantNames = new Map(
            [...variantNamesMeta.entries()].map(([id, m]) => [id, m.name]),
        );
        const admin = await this.resolveAdmin(ctx);
        for (const update of updates) {
            const currencyCode = update.currencyCode ?? channelCurrency.get(`${update.channelId}`);
            if (!currencyCode) {
                throw new UserInputError(`No currency for channel ${update.channelId}`);
            }
            await this.productVariantService.createOrUpdateProductVariantPrice(
                ctx,
                update.variantId,
                update.price,
                update.channelId,
                currencyCode,
            );
        }
        const logRows = buildLogRows(updates, {
            variantNames,
            channelNames,
            oldPrices,
            currencyByChannel: channelCurrency as Map<string, string>,
            adminId: admin.adminId,
            adminName: admin.adminName,
        });
        if (logRows.length) {
            await this.connection
                .getRepository(ctx, PriceChangeLog)
                .save(logRows.map(r => new PriceChangeLog(r)));
        }
        const variantIds = [...new Set(updates.map(u => `${u.variantId}`))];
        await this.publishVariantUpdate(ctx, variantIds);
        Logger.info(
            `Updated ${updates.length} price cell(s); logged ${logRows.length} change(s) across ${variantIds.length} variant(s)`,
            loggerCtx,
        );
        return { updatedCount: updates.length, variantIds };
    }

    /**
     * One query for both write-time facts about the affected variants: channel
     * assignment (validation) and current prices (audit oldPrice). Joining both
     * one-to-many relations yields a channels×prices row product per variant, but
     * TypeORM dedupes into correct arrays; the counts here are tiny.
     */
    private async loadWriteState(
        ctx: RequestContext,
        updates: SetVariantChannelPriceInput[],
    ): Promise<{ assignment: Map<string, Set<string>>; oldPrices: Map<string, number> }> {
        const variantIds = [...new Set(updates.map(u => `${u.variantId}`))];
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('v')
            .leftJoinAndSelect('v.channels', 'channel')
            .leftJoinAndSelect('v.productVariantPrices', 'price')
            .where('v.id IN (:...variantIds)', { variantIds })
            .getMany();
        const assignment = new Map<string, Set<string>>();
        const oldPrices = new Map<string, number>();
        for (const variant of variants) {
            assignment.set(`${variant.id}`, new Set((variant.channels ?? []).map(c => `${c.id}`)));
            for (const price of variant.productVariantPrices ?? []) {
                oldPrices.set(`${variant.id}:${(price as any).channelId}`, price.price);
            }
        }
        return { assignment, oldPrices };
    }

    /** Resolve "<first> <last>" for the acting admin; "<unknown>" if none. */
    private async resolveAdmin(
        ctx: RequestContext,
    ): Promise<{ adminId?: ID; adminName: string }> {
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

    private async getChannelColumns(ctx: RequestContext): Promise<PriceMatrixChannelColumn[]> {
        const channels = await this.channelService.findAll(ctx);
        return channels.items.map(c => ({
            id: c.id,
            code: c.code,
            currencyCode: c.defaultCurrencyCode,
        }));
    }

    private async getVariantNames(
        ctx: RequestContext,
        variantIds: ID[],
    ): Promise<Map<string, { name: string; sku: string }>> {
        if (!variantIds.length) {
            return new Map();
        }
        const translated = await this.productVariantService.findByIds(ctx, variantIds);
        return new Map(translated.map(v => [`${v.id}`, { name: v.name, sku: v.sku }]));
    }

    private buildRow(
        variant: ProductVariant,
        channels: PriceMatrixChannelColumn[],
        names: Map<string, { name: string; sku: string }>,
    ): PriceMatrixRow {
        const assigned = new Set((variant.channels ?? []).map(c => `${c.id}`));
        const priceByChannel = new Map(
            (variant.productVariantPrices ?? []).map(p => [`${(p as any).channelId}`, p]),
        );
        const meta = names.get(`${variant.id}`);
        // One cell per column (the result's used channels). assigned=false =>
        // "not sold" (variant not in that channel); price=null => assigned but
        // no price yet (editable).
        const cells: PriceMatrixCell[] = channels.map(channel => {
            const existing = priceByChannel.get(`${channel.id}`);
            return {
                channelId: channel.id,
                currencyCode: (existing?.currencyCode as CurrencyCode) ?? channel.currencyCode,
                price: existing ? existing.price : null,
                assigned: assigned.has(`${channel.id}`),
            };
        });
        return {
            variantId: variant.id,
            productId: (variant as any).productId,
            name: meta?.name ?? variant.sku,
            sku: meta?.sku ?? variant.sku,
            cells,
        };
    }

    /** Reject any (variant, channel) pair where the variant is not in that channel. */
    private assertAllAssigned(
        assignment: Map<string, Set<string>>,
        updates: SetVariantChannelPriceInput[],
    ): void {
        for (const update of updates) {
            const channels = assignment.get(`${update.variantId}`);
            if (!channels || !channels.has(`${update.channelId}`)) {
                throw new UserInputError(
                    `Variant ${update.variantId} is not assigned to channel ${update.channelId}`,
                );
            }
        }
    }

    /** Fire ProductVariantEvent so the cart-sync PriceUpdatePlugin re-prices open orders. */
    private async publishVariantUpdate(ctx: RequestContext, variantIds: ID[]): Promise<void> {
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .find({ where: { id: In(variantIds) } });
        if (variants.length) {
            await this.eventBus.publish(new ProductVariantEvent(ctx, variants, 'updated'));
        }
    }
}
