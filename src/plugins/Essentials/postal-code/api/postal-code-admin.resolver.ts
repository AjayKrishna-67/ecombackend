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
import { PostalCode } from '../entities/postal-code.entity';
import { PostalCodeArea } from '../entities/postal-code-area.entity';
import { PostalCodeService } from '../services/postal-code.service';
import { postalCodePermission } from '../permissions';
import { DeletionResponse } from '@vendure/common/lib/generated-types';

@Resolver()
export class PostalCodeAdminResolver {
    constructor(private postalCodeService: PostalCodeService) {}

    @Query()
    @Allow(postalCodePermission.Read, Permission.SuperAdmin)
    async postalCode(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
        @Relations(PostalCode) relations: RelationPaths<PostalCode>,
    ): Promise<PostalCode | null> {
        return this.postalCodeService.findOne(ctx, args.id, relations);
    }

    @Query()
    @Allow(postalCodePermission.Read, Permission.SuperAdmin)
    async postalCodes(
        @Ctx() ctx: RequestContext,
        @Args() args: { options: ListQueryOptions<PostalCode> },
        @Relations(PostalCode) relations: RelationPaths<PostalCode>,
    ): Promise<PaginatedList<PostalCode>> {
        return this.postalCodeService.findAll(ctx, args.options || undefined, relations);
    }

    @Query()
    @Allow(postalCodePermission.Read, Permission.SuperAdmin)
    async postalCodeAreas(
        @Ctx() ctx: RequestContext,
        @Args() args: { postalCodeId?: ID },
    ): Promise<PostalCodeArea[]> {
        if (args.postalCodeId) {
            return this.postalCodeService.findAreasByPostalCode(ctx, args.postalCodeId);
        }
        return this.postalCodeService.findAllAreas(ctx);
    }

    @Mutation()
    @Transaction()
    @Allow(postalCodePermission.Create, Permission.SuperAdmin)
    async createPostalCode(
        @Ctx() ctx: RequestContext,
        @Args('input') input: { code: string; isAnywhere?: boolean },
    ): Promise<PostalCode> {
        return this.postalCodeService.create(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(postalCodePermission.Update, Permission.SuperAdmin)
    async updatePostalCode(
        @Ctx() ctx: RequestContext,
        @Args('input') input: { id: ID; code?: string; isAnywhere?: boolean },
    ): Promise<PostalCode> {
        return this.postalCodeService.update(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(postalCodePermission.Delete, Permission.SuperAdmin)
    async deletePostalCode(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.postalCodeService.delete(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(postalCodePermission.Create, Permission.SuperAdmin)
    async createPostalCodeArea(
        @Ctx() ctx: RequestContext,
        @Args('input') input: { postalCodeId: ID; name: string },
    ): Promise<PostalCodeArea> {
        return this.postalCodeService.createArea(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(postalCodePermission.Update, Permission.SuperAdmin)
    async updatePostalCodeArea(
        @Ctx() ctx: RequestContext,
        @Args('input') input: { id: ID; name?: string; enabled?: boolean },
    ): Promise<PostalCodeArea> {
        return this.postalCodeService.updateArea(ctx, input);
    }

    @Mutation()
    @Transaction()
    @Allow(postalCodePermission.Delete, Permission.SuperAdmin)
    async deletePostalCodeArea(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<DeletionResponse> {
        return this.postalCodeService.deleteArea(ctx, args.id);
    }
}
