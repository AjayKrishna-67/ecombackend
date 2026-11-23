import { Injectable } from '@nestjs/common';
import {
    Asset,
    CacheService,
    ID,
    Logger,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { In } from 'typeorm';
import { BrandStorefront, BrandLaunchStatus } from '../entities/brand-storefront.entity';
import { CHANNEL_AVAIL_TAG_ALL } from './channel-availability.service';

export interface UpsertBrandStorefrontInput {
    sellerId: ID;
    bannerImageId?: ID | null;
    launchStatus?: BrandLaunchStatus;
    showInStoreSwitcher?: boolean;
    sortOrder?: number | null;
}

@Injectable()
export class BrandStorefrontService {
    constructor(
        private connection: TransactionalConnection,
        private cacheService: CacheService,
    ) {}

    /**
     * Batch-load storefront rows for a set of seller ids, keyed by sellerId.
     * Used by ChannelAvailabilityService to avoid N+1.
     */
    async findBySellerIds(
        ctx: RequestContext,
        sellerIds: ID[],
    ): Promise<Map<string, BrandStorefront>> {
        const ids = [...new Set(sellerIds.map(String))].filter(Boolean);
        if (ids.length === 0) return new Map();
        const rows = await this.connection.getRepository(ctx, BrandStorefront).find({
            where: { seller: { id: In(ids as any) } },
            relations: ['seller', 'bannerImage'],
        });
        const map = new Map<string, BrandStorefront>();
        for (const row of rows) {
            if (row.seller) map.set(String(row.seller.id), row);
        }
        return map;
    }

    /**
     * All storefront rows (admin list).
     */
    findAll(ctx: RequestContext): Promise<BrandStorefront[]> {
        return this.connection.getRepository(ctx, BrandStorefront).find({
            relations: ['seller', 'bannerImage'],
            order: { sortOrder: 'ASC' },
        });
    }

    /**
     * Published brands for the app switcher: showInStoreSwitcher = true,
     * ordered by sortOrder. Opening-soon brands ARE included (app shows them
     * locked); launchStatus tells the app whether to lock.
     */
    findPublished(ctx: RequestContext): Promise<BrandStorefront[]> {
        return this.connection.getRepository(ctx, BrandStorefront).find({
            where: { showInStoreSwitcher: true },
            relations: ['seller', 'bannerImage'],
            order: { sortOrder: 'ASC' },
        });
    }

    /**
     * Single storefront by seller id (admin edit).
     */
    findBySeller(ctx: RequestContext, sellerId: ID): Promise<BrandStorefront | null> {
        return this.connection.getRepository(ctx, BrandStorefront).findOne({
            where: { seller: { id: sellerId as any } },
            relations: ['seller', 'bannerImage'],
        });
    }

    /**
     * Create or update the storefront row for a seller, then clear the
     * 15-minute availability cache so the app sees the change immediately.
     */
    async upsert(ctx: RequestContext, input: UpsertBrandStorefrontInput): Promise<BrandStorefront> {
        const repo = this.connection.getRepository(ctx, BrandStorefront);
        let row = await repo.findOne({ where: { seller: { id: input.sellerId as any } } });
        if (!row) {
            row = new BrandStorefront({ seller: { id: input.sellerId } as any });
        }
        if ('bannerImageId' in input) {
            row.bannerImage = input.bannerImageId ? ({ id: input.bannerImageId } as Asset) : null;
        }
        if (input.launchStatus !== undefined) row.launchStatus = input.launchStatus;
        if (input.showInStoreSwitcher !== undefined) row.showInStoreSwitcher = input.showInStoreSwitcher;
        if (input.sortOrder !== undefined) row.sortOrder = input.sortOrder;
        const saved = await repo.save(row);
        await this.cacheService.invalidateTags([CHANNEL_AVAIL_TAG_ALL]);
        Logger.debug(`[BrandStorefrontService] upserted storefront for seller ${input.sellerId}`);
        return (await this.findBySeller(ctx, input.sellerId)) ?? saved;
    }

    /**
     * Persist a new switcher order: sortOrder becomes the array index.
     * Atomic upsert keyed on the unique sellerId — safe against concurrent
     * reorder calls (find-then-insert would race and violate the unique index).
     * Creates a storefront row for any seller that lacks one; other columns
     * take their DB defaults.
     */
    async setOrder(ctx: RequestContext, sellerIds: ID[]): Promise<boolean> {
        const repo = this.connection.getRepository(ctx, BrandStorefront);
        for (let i = 0; i < sellerIds.length; i++) {
            await repo.query(
                'INSERT INTO `brand_storefront` (`sellerId`, `sortOrder`) VALUES (?, ?) ' +
                    'ON DUPLICATE KEY UPDATE `sortOrder` = VALUES(`sortOrder`)',
                [sellerIds[i], i],
            );
        }
        await this.cacheService.invalidateTags([CHANNEL_AVAIL_TAG_ALL]);
        return true;
    }
}
