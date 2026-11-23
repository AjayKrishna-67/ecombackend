import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Product, Customer, RequestContext, translateDeep } from '@vendure/core';
import { FavoritesService } from '../services/favorites.service';
import { Favorite } from '../entities/favorite.entity';

@Resolver('Favorite')
export class FavoriteEntityResolver {
    constructor(private favoritesService: FavoritesService) {}

    @ResolveField()
    async product(@Parent() favorite: Favorite, @Ctx() ctx: RequestContext): Promise<Product | null> {
        if (favorite.product) {
            return translateDeep(favorite.product, ctx.languageCode);
        }

        const loadedFavorite = await this.favoritesService.findOne(ctx, favorite.id, ['product']);
        if (loadedFavorite?.product) {
            return translateDeep(loadedFavorite.product, ctx.languageCode);
        }
        return null;
    }

    @ResolveField()
    async customer(@Parent() favorite: Favorite, @Ctx() ctx: RequestContext): Promise<Customer | null> {
        if (favorite.customer) {
            return favorite.customer;
        }

        const loadedFavorite = await this.favoritesService.findOne(ctx, favorite.id, ['customer']);
        return loadedFavorite?.customer ?? null;
    }
}
