import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Permission, RequestContext, Transaction } from '@vendure/core';
import { BrandStorefront } from '../entities/brand-storefront.entity';
import {
    BrandStorefrontService,
    UpsertBrandStorefrontInput,
} from '../services/brand-storefront.service';
import { brandStorefrontPermission } from '../permissions';

@Resolver()
export class BrandStorefrontAdminResolver {
    constructor(private brandStorefrontService: BrandStorefrontService) {}

    @Query()
    @Allow(brandStorefrontPermission.Read, Permission.SuperAdmin)
    async brandStorefronts(@Ctx() ctx: RequestContext): Promise<BrandStorefront[]> {
        return this.brandStorefrontService.findAll(ctx);
    }

    @Query()
    @Allow(brandStorefrontPermission.Read, Permission.SuperAdmin)
    async brandStorefront(
        @Ctx() ctx: RequestContext,
        @Args() args: { sellerId: ID },
    ): Promise<BrandStorefront | null> {
        return this.brandStorefrontService.findBySeller(ctx, args.sellerId);
    }

    @Mutation()
    @Transaction()
    @Allow(brandStorefrontPermission.Update, Permission.SuperAdmin)
    async upsertBrandStorefront(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpsertBrandStorefrontInput },
    ): Promise<BrandStorefront> {
        return this.brandStorefrontService.upsert(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(brandStorefrontPermission.Update, Permission.SuperAdmin)
    async setBrandStorefrontOrder(
        @Ctx() ctx: RequestContext,
        @Args() args: { sellerIds: ID[] },
    ): Promise<boolean> {
        return this.brandStorefrontService.setOrder(ctx, args.sellerIds);
    }
}
