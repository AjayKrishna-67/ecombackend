import { Resolver, Query, Args } from '@nestjs/graphql';
import { Ctx, RequestContext, Allow, Permission, ID } from '@vendure/core';
import { FavoritesService } from '../services/favorites.service';
import { Favorite } from '../entities/favorite.entity';

@Resolver()
export class FavoriteAdminResolver {
    constructor(private favoritesService: FavoritesService) {}

    @Query(() => Favorite, { nullable: true })
    @Allow(Permission.ReadCustomer)
    async favorite(
        @Ctx() ctx: RequestContext,
        @Args('id') id: ID,
    ): Promise<Favorite | null> {
        return this.favoritesService.findOne(ctx, id, ['product', 'customer']);
    }

    @Query()
    @Allow(Permission.ReadCustomer)
    async favorites(
        @Ctx() ctx: RequestContext,
        @Args('customerId') customerId: ID,
        @Args('options') options: any,
    ) {
        return this.favoritesService.findAll(ctx, customerId, options);
    }
}
