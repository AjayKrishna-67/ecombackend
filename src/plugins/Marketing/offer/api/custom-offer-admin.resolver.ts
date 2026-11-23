import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DeletionResponse, Permission } from '@vendure/common/lib/generated-types';
import {
    Allow,
    Ctx,
    ID,
    ListQueryOptions,
    PaginatedList,
    RelationPaths,
    Relations,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { CustomOffer } from '../entities/custom-offer.entity';
import { CustomOfferService } from '../services/custom-offer.service';
import { offerPermission } from '../permissions';

interface CreateBannerPopupInput {
    assetId: ID;
    productId?: ID | null;
    collectionId?: ID | null;
    productVariantId?: ID | null;
    isPreview?: boolean;
}

interface UpdateBannerPopupInput {
    id: ID;
    assetId?: ID | null;
    productId?: ID | null;
    collectionId?: ID | null;
    productVariantId?: ID | null;
    isPreview?: boolean;
}

@Resolver()
export class CustomOfferAdminResolver {
    constructor(private customOfferService: CustomOfferService) {}

    @Query()
    @Allow(offerPermission.Read, Permission.SuperAdmin)
    async bannerPopup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
        @Relations(CustomOffer) relations: RelationPaths<CustomOffer>,
    ): Promise<CustomOffer | null> {
        return this.customOfferService.findOne(ctx, args.id, relations);
    }

    @Query()
    @Allow(offerPermission.Read, Permission.SuperAdmin)
    async allBannerPopup(
        @Ctx() ctx: RequestContext,
        @Args() args: { options: ListQueryOptions<CustomOffer> },
        @Relations(CustomOffer) relations: RelationPaths<CustomOffer>,
    ): Promise<PaginatedList<CustomOffer>> {
        return this.customOfferService.findAll(ctx, args.options || undefined, relations);
    }

    @Mutation()
    @Transaction()
    @Allow(offerPermission.Create, Permission.SuperAdmin)
    async createBannerPopup(
        @Ctx() ctx: RequestContext,
        @Args('input') input: CreateBannerPopupInput,
    ): Promise<CustomOffer> {
        return this.customOfferService.create(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(offerPermission.Update, Permission.SuperAdmin)
    async updateBannerPopup(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdateBannerPopupInput },
    ): Promise<CustomOffer> {
        return this.customOfferService.update(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(offerPermission.Delete, Permission.SuperAdmin)
    async deleteBannerPopup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.customOfferService.delete(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(offerPermission.Update, Permission.SuperAdmin)
    async resetBannerPopupRotation(@Ctx() ctx: RequestContext): Promise<number> {
        return this.customOfferService.resetRotation(ctx);
    }
}
