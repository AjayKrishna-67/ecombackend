import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ID,
    ListQueryOptions,
    Permission,
    Product,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { TagMatchMode } from '../../tags/services/tag.service';
import { PriceChangeLog } from '../entities/price-change-log.entity';
import {
    PriceChangeHistoryOptions,
    PriceMatrixService,
    SetVariantChannelPriceInput,
    VariantPriceMatrix,
} from '../services/price-matrix.service';

@Resolver()
export class PriceMatrixAdminResolver {
    constructor(private priceMatrixService: PriceMatrixService) {}

    @Query()
    @Allow(Permission.UpdateCatalog)
    variantPriceMatrix(
        @Ctx() ctx: RequestContext,
        @Args()
        args: { tagIds: ID[]; matchMode?: TagMatchMode; options?: ListQueryOptions<Product> },
    ): Promise<VariantPriceMatrix> {
        return this.priceMatrixService.getMatrix(ctx, {
            tagIds: args.tagIds,
            matchMode: args.matchMode,
            options: args.options ?? undefined,
        });
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    priceChangeHistory(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: PriceChangeHistoryOptions },
    ): Promise<{ items: PriceChangeLog[]; totalItems: number }> {
        return this.priceMatrixService.getHistory(ctx, args.options ?? {});
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateCatalog)
    setVariantChannelPrices(
        @Ctx() ctx: RequestContext,
        @Args() args: { updates: SetVariantChannelPriceInput[] },
    ): Promise<{ updatedCount: number; variantIds: ID[] }> {
        return this.priceMatrixService.setPrices(ctx, args.updates);
    }
}
