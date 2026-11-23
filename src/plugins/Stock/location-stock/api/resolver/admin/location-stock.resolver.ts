import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Permission, RequestContext, Transaction } from '@vendure/core';
import { TagMatchMode } from '../../../../../Essentials/tags/services/tag.service';
import { StockChangeLog } from '../../../entities/stock-change-log.entity';
import { assertGlobalPermissions } from '../../assert-global-permissions';
import {
    LocationStockRow,
    LocationStockService,
    ProductPoolStockRow,
    SetProductPoolStockInput,
    SetVariantStockInput,
    StockChangeHistoryOptions,
} from '../../../services/location-stock.service';

// View needs read on both tables the tool touches; edit needs update on both.
// Checked globally (any channel) — see assertGlobalPermissions.
const READ_PERMISSIONS = [Permission.ReadProduct, Permission.ReadStockLocation];
const WRITE_PERMISSIONS = [Permission.UpdateProduct, Permission.UpdateStockLocation];

@Resolver()
export class LocationStockAdminResolver {
    constructor(private locationStockService: LocationStockService) {}

    @Query()
    @Allow(Permission.Authenticated)
    locationVariantStock(
        @Ctx() ctx: RequestContext,
        @Args() args: { stockLocationId: ID; tagIds?: ID[]; matchMode?: TagMatchMode; search?: string },
    ): Promise<LocationStockRow[]> {
        assertGlobalPermissions(ctx, READ_PERMISSIONS);
        return this.locationStockService.getVariantStock(ctx, args);
    }

    @Query()
    @Allow(Permission.Authenticated)
    locationProductPoolStock(
        @Ctx() ctx: RequestContext,
        @Args() args: { stockLocationId: ID; tagIds?: ID[]; matchMode?: TagMatchMode; search?: string },
    ): Promise<ProductPoolStockRow[]> {
        assertGlobalPermissions(ctx, READ_PERMISSIONS);
        return this.locationStockService.getProductPoolStock(ctx, args);
    }

    @Query()
    @Allow(Permission.Authenticated)
    stockChangeHistory(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: StockChangeHistoryOptions },
    ): Promise<{ items: StockChangeLog[]; totalItems: number }> {
        assertGlobalPermissions(ctx, READ_PERMISSIONS);
        return this.locationStockService.getHistory(ctx, args.options ?? {});
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.Authenticated)
    setVariantStockOnHand(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: SetVariantStockInput },
    ): Promise<boolean> {
        assertGlobalPermissions(ctx, WRITE_PERMISSIONS);
        return this.locationStockService.setVariantStockOnHand(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.Authenticated)
    setProductPoolStock(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: SetProductPoolStockInput },
    ): Promise<boolean> {
        assertGlobalPermissions(ctx, WRITE_PERMISSIONS);
        return this.locationStockService.setProductPoolStock(ctx, args.input);
    }
}
