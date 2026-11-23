import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { Inject } from '@nestjs/common';
import {
    Allow,
    Ctx,
    Permission,
    RequestContext,
} from '@vendure/core';
import { FavoritesService } from '../services/favorites.service';
import { PLUGIN_INIT_OPTIONS } from '../constants';
import { PluginInitOptions } from '../types';

@Resolver()
export class FavoriteShopResolver {
    constructor(
        private favoritesService: FavoritesService,
        @Inject(PLUGIN_INIT_OPTIONS) private options: PluginInitOptions,
    ) {}

    @Mutation()
    @Allow(Permission.Owner)
    async toggleFavorite(
        @Ctx() ctx: RequestContext,
        @Args() args: { productId: string },
    ) {
        return this.favoritesService.toggleFavorite(
            ctx,
            args.productId,
            this.options.trackHistory,
        );
    }
}
