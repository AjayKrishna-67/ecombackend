import { Injectable } from '@nestjs/common';
import { CacheService, ID, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import { BrandSwitcherEntry } from '../entities/brand-switcher-entry.entity';
import { CHANNEL_AVAIL_TAG_ALL } from './channel-availability.service';

@Injectable()
export class BrandSwitcherService {
    constructor(
        private connection: TransactionalConnection,
        private cacheService: CacheService,
    ) {}

    /**
     * Ordered target seller ids a host app shows in its switcher.
     * Empty array = host has no configured allowlist (caller decides fallback).
     */
    async findTargetSellerIds(ctx: RequestContext, hostSellerId: ID): Promise<string[]> {
        const rows = await this.connection.getRepository(ctx, BrandSwitcherEntry).find({
            where: { hostSeller: { id: hostSellerId as any } },
            relations: ['targetSeller'],
            order: { sortOrder: 'ASC' },
        });
        return rows.map(row => String(row.targetSeller?.id)).filter(Boolean);
    }

    /**
     * All rows for a host (admin list): ordered, with the target seller loaded.
     */
    findByHost(ctx: RequestContext, hostSellerId: ID): Promise<BrandSwitcherEntry[]> {
        return this.connection.getRepository(ctx, BrandSwitcherEntry).find({
            where: { hostSeller: { id: hostSellerId as any } },
            relations: ['hostSeller', 'targetSeller'],
            order: { sortOrder: 'ASC' },
        });
    }

    /**
     * Replace a host's allowlist with `targetSellerIds` in the given order.
     * Atomic upsert per pair keyed on the unique (host, target) index, then
     * delete any rows for targets no longer in the list. Safe against the
     * unique-index race a find-then-insert would hit.
     */
    async setAllowlist(ctx: RequestContext, hostSellerId: ID, targetSellerIds: ID[]): Promise<boolean> {
        const repo = this.connection.getRepository(ctx, BrandSwitcherEntry);
        for (let i = 0; i < targetSellerIds.length; i++) {
            await repo.query(
                'INSERT INTO `brand_switcher_entry` (`hostSellerId`, `targetSellerId`, `sortOrder`) VALUES (?, ?, ?) ' +
                    'ON DUPLICATE KEY UPDATE `sortOrder` = VALUES(`sortOrder`)',
                [hostSellerId, targetSellerIds[i], i],
            );
        }
        if (targetSellerIds.length > 0) {
            await repo
                .createQueryBuilder()
                .delete()
                .where('hostSellerId = :host', { host: hostSellerId })
                .andWhere('targetSellerId NOT IN (:...keep)', { keep: targetSellerIds })
                .execute();
        } else {
            await repo
                .createQueryBuilder()
                .delete()
                .where('hostSellerId = :host', { host: hostSellerId })
                .execute();
        }
        await this.cacheService.invalidateTags([CHANNEL_AVAIL_TAG_ALL]);
        Logger.debug(`[BrandSwitcherService] set allowlist for host ${hostSellerId}: [${targetSellerIds.join(',')}]`);
        return true;
    }
}
