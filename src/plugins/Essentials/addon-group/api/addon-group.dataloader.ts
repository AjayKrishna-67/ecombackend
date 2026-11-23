import { Injectable, Scope } from '@nestjs/common';
import { ID, RequestContext, TransactionalConnection } from '@vendure/core';
import DataLoader from 'dataloader';
import { In } from 'typeorm';
import { AddonGroup } from '../entities/addon-group.entity';

/**
 * Request-scoped DataLoader for AddonGroup lookups.
 *
 * Without it, the `addonSelections` / `addonsAvailable` field resolvers on
 * OrderLine each fire their own `AddonGroup.find()` — one query per line. A
 * cart with 20 lines = 20 near-simultaneous queries (the N+1 problem), most of
 * them re-fetching the same groups.
 *
 * DataLoader collects every group id requested within a single tick, dedupes
 * them, and issues ONE `WHERE id IN (...)` query. The loader is scoped to the
 * request (Scope.REQUEST) so its per-tick cache never leaks across requests and
 * always reflects the current channel's RequestContext.
 */
@Injectable({ scope: Scope.REQUEST })
export class AddonGroupDataLoader {
    private loader: DataLoader<ID, AddonGroup | undefined> | undefined;

    constructor(private readonly connection: TransactionalConnection) {}

    getLoader(ctx: RequestContext): DataLoader<ID, AddonGroup | undefined> {
        if (!this.loader) {
            this.loader = new DataLoader<ID, AddonGroup | undefined>(ids => this.batchLoadGroups(ctx, ids as ID[]));
        }
        return this.loader;
    }

    private async batchLoadGroups(ctx: RequestContext, ids: ID[]): Promise<Array<AddonGroup | undefined>> {
        const groups = await this.connection.getRepository(ctx, AddonGroup).find({
            where: { id: In(ids as Array<string | number>) },
            relations: ['items'],
        });
        const groupById = new Map(groups.map(group => [String(group.id), group]));
        // DataLoader contract: return array MUST match the input order and length.
        return ids.map(id => groupById.get(String(id)));
    }
}
