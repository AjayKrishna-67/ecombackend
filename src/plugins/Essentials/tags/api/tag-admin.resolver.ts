import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { DeletionResponse } from '@vendure/common/lib/generated-types';
import {
    Allow,
    Ctx,
    ID,
    ListQueryOptions,
    PaginatedList,
    Permission,
    Product,
    ProductVariant,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { CatalogTag } from '../entities/tag.entity';
import { TagMatchMode, TagService } from '../services/tag.service';

@Resolver()
export class TagAdminResolver {
    constructor(private tagService: TagService) {}

    @Query()
    @Allow(Permission.ReadCatalog)
    catalogTags(@Ctx() ctx: RequestContext): Promise<CatalogTag[]> {
        return this.tagService.findAll(ctx);
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    tagSuggestions(@Ctx() ctx: RequestContext, @Args() args: { term?: string }): Promise<CatalogTag[]> {
        return this.tagService.suggest(ctx, args.term ?? '');
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    productTags(@Ctx() ctx: RequestContext, @Args() args: { productId: ID }): Promise<CatalogTag[]> {
        return this.tagService.getTagsForProduct(ctx, args.productId);
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    variantTags(@Ctx() ctx: RequestContext, @Args() args: { variantId: ID }): Promise<CatalogTag[]> {
        return this.tagService.getTagsForVariant(ctx, args.variantId);
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    productsByTag(
        @Ctx() ctx: RequestContext,
        @Args() args: { tagIds: ID[]; matchMode?: TagMatchMode; options?: ListQueryOptions<Product> },
    ): Promise<PaginatedList<Product>> {
        return this.tagService.getProductsByTag(ctx, {
            tagIds: args.tagIds,
            matchMode: args.matchMode,
            options: args.options ?? undefined,
        });
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    tagProducts(@Ctx() ctx: RequestContext, @Args() args: { tagId: ID }): Promise<Product[]> {
        return this.tagService.getProductsForTag(ctx, args.tagId);
    }

    @Query()
    @Allow(Permission.ReadCatalog)
    tagVariants(@Ctx() ctx: RequestContext, @Args() args: { tagId: ID }): Promise<ProductVariant[]> {
        return this.tagService.getVariantsForTag(ctx, args.tagId);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.CreateCatalog)
    findOrCreateTag(@Ctx() ctx: RequestContext, @Args() args: { value: string }): Promise<CatalogTag> {
        return this.tagService.findOrCreate(ctx, args.value);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateCatalog)
    setProductTags(
        @Ctx() ctx: RequestContext,
        @Args() args: { productId: ID; tagIds: ID[] },
    ): Promise<CatalogTag[]> {
        return this.tagService.setProductTags(ctx, args.productId, args.tagIds);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateCatalog)
    setVariantTags(
        @Ctx() ctx: RequestContext,
        @Args() args: { variantId: ID; tagIds: ID[] },
    ): Promise<CatalogTag[]> {
        return this.tagService.setVariantTags(ctx, args.variantId, args.tagIds);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.DeleteCatalog)
    deleteCatalogTag(@Ctx() ctx: RequestContext, @Args() args: { id: ID }): Promise<DeletionResponse> {
        return this.tagService.deleteTag(ctx, args.id);
    }
}
