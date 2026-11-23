import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';

import { bulkSyncPermission } from './permissions';
import { BulkSyncService, SyncRow } from './bulk-sync.service';

@Resolver()
export class BulkSyncResolver {
    constructor(private readonly bulkSyncService: BulkSyncService) {}

    @Mutation()
    @Allow(Permission.SuperAdmin, bulkSyncPermission.Permission as unknown as Permission)
    async bulkSyncProducts(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { city: string; rows: SyncRow[] } },
    ) {
        return this.bulkSyncService.bulkUpdate(ctx, args.input.city, args.input.rows);
    }

    @Query()
    @Allow(Permission.SuperAdmin, bulkSyncPermission.Permission as unknown as Permission)
    async bulkSyncExport(
        @Ctx() ctx: RequestContext,
        @Args() args: { city?: string },
    ) {
        if (args.city) {
            return { city: args.city, rows: await this.bulkSyncService.exportByCity(ctx, args.city) };
        }
        const all = await this.bulkSyncService.exportAllCities(ctx);
        return { city: null, byCity: Object.entries(all).map(([city, rows]) => ({ city, rows })) };
    }
}
