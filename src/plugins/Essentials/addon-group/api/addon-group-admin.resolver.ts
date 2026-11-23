import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ID,
    ListQueryOptions,
    PaginatedList,
    Permission,
    RelationPaths,
    Relations,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { DeletionResponse } from '@vendure/common/lib/generated-types';
import { AddonGroup } from '../entities/addon-group.entity';
import { AddonItem } from '../entities/addon-item.entity';
import { AddonGroupService } from '../services/addon-group.service';
import { addonGroupPermission } from '../permissions';

@Resolver()
export class AddonGroupAdminResolver {
    constructor(private addonGroupService: AddonGroupService) {}

    @Query()
    @Allow(addonGroupPermission.Read, Permission.SuperAdmin)
    async addonGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
        @Relations(AddonGroup) relations: RelationPaths<AddonGroup>,
    ): Promise<AddonGroup | null> {
        return this.addonGroupService.findOne(ctx, args.id, relations);
    }

    @Query()
    @Allow(addonGroupPermission.Read, Permission.SuperAdmin)
    async addonGroups(
        @Ctx() ctx: RequestContext,
        @Args() args: { options: ListQueryOptions<AddonGroup> },
        @Relations(AddonGroup) relations: RelationPaths<AddonGroup>,
    ): Promise<PaginatedList<AddonGroup>> {
        return this.addonGroupService.findAll(ctx, args.options || undefined, relations);
    }

    @Query()
    @Allow(addonGroupPermission.Read, Permission.SuperAdmin)
    async variantsWithAddonGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { addonGroupId: ID },
    ): Promise<Array<{ id: ID; name: string; sku: string; productId: ID; productName: string }>> {
        return this.addonGroupService.findVariantsByAddonGroup(ctx, args.addonGroupId);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Create, Permission.SuperAdmin)
    async createAddonGroup(
        @Ctx() ctx: RequestContext,
        @Args('input') input: {
            name: string;
            description?: string;
            selectionType?: string;
            isRequired?: boolean;
            minSelections?: number;
            maxSelections?: number;
            sortOrder?: number;
            enabled?: boolean;
        },
    ): Promise<AddonGroup> {
        return this.addonGroupService.create(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Update, Permission.SuperAdmin)
    async updateAddonGroup(
        @Ctx() ctx: RequestContext,
        @Args('input') input: {
            id: ID;
            name?: string;
            description?: string;
            selectionType?: string;
            isRequired?: boolean;
            minSelections?: number;
            maxSelections?: number;
            sortOrder?: number;
            enabled?: boolean;
        },
    ): Promise<AddonGroup> {
        return this.addonGroupService.update(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Delete, Permission.SuperAdmin)
    async deleteAddonGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.addonGroupService.delete(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Create, Permission.SuperAdmin)
    async createAddonItem(
        @Ctx() ctx: RequestContext,
        @Args('input') input: {
            groupId: ID;
            name: string;
            price?: number;
            sku?: string;
            isDefault?: boolean;
            minQuantity?: number;
            maxQuantity?: number;
            sortOrder?: number;
            enabled?: boolean;
            imageId?: ID;
        },
    ): Promise<AddonItem> {
        return this.addonGroupService.createItem(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Update, Permission.SuperAdmin)
    async updateAddonItem(
        @Ctx() ctx: RequestContext,
        @Args('input') input: {
            id: ID;
            name?: string;
            price?: number;
            sku?: string;
            isDefault?: boolean;
            minQuantity?: number;
            maxQuantity?: number;
            sortOrder?: number;
            enabled?: boolean;
            imageId?: ID | null;
        },
    ): Promise<AddonItem> {
        return this.addonGroupService.updateItem(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Delete, Permission.SuperAdmin)
    async deleteAddonItem(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.addonGroupService.deleteItem(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Update, Permission.SuperAdmin)
    async assignAddonGroupsToChannel(
        @Ctx() ctx: RequestContext,
        @Args('input') input: { addonGroupIds: ID[]; channelId: ID },
    ): Promise<AddonGroup[]> {
        return this.addonGroupService.assignToChannel(ctx, input.addonGroupIds, input.channelId);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Update, Permission.SuperAdmin)
    async removeAddonGroupsFromChannel(
        @Ctx() ctx: RequestContext,
        @Args('input') input: { addonGroupIds: ID[]; channelId: ID },
    ): Promise<AddonGroup[]> {
        return this.addonGroupService.removeFromChannel(ctx, input.addonGroupIds, input.channelId);
    }

    @Mutation()
    @Transaction()
    @Allow(addonGroupPermission.Update, Permission.SuperAdmin)
    async recomputeAddonSurcharges(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderId: ID },
    ): Promise<boolean> {
        return this.addonGroupService.recomputeAddonSurchargesForOrder(ctx, args.orderId);
    }
}
