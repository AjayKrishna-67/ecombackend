import { VendurePlugin, PluginCommonModule } from '@vendure/core';

import { Favorite } from './entities/favorite.entity';
import { FavoritesService } from './services/favorites.service';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { CustomerEntityResolver } from './api/customer-entity.resolver';
import { FavoriteEntityResolver } from './api/favorite-entity.resolver';
import { FavoriteShopResolver } from './api/favorite-shop.resolver';
import { FavoriteAdminResolver } from './api/favorite-admin-resolver';
import { PLUGIN_INIT_OPTIONS } from './constants';
import { PluginInitOptions } from './types';

/**
 * A Vendure plugin to give customers the ability to favorite products.
 *
 * @example
 * ```TypeScript
 * export const config: VendureConfig = {
 *   //...
 *   plugins: [
 *     FavoritesPlugin.init({
 *       trackHistory: true
 *     }),
 *   ]
 * }
 * ```
 */
@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [Favorite],
  compatibility: '^3.6.3',

  adminApiExtensions: {
  schema: adminApiExtensions,
  resolvers: [CustomerEntityResolver, FavoriteEntityResolver, FavoriteAdminResolver],
  },
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: [CustomerEntityResolver, FavoriteEntityResolver, FavoriteShopResolver],
  },

  providers: [
    FavoritesService,
    { provide: PLUGIN_INIT_OPTIONS, useFactory: () => FavoritesPlugin.options },
  ],
})
export class FavoritesPlugin {
  static options: PluginInitOptions = {
    trackHistory: false
  };
  
  /**
   * The static `init()` method is a convention used by Vendure plugins which allows options
   * to be configured by the user.
   */
  static init(options: PluginInitOptions) {
    this.options = options;
    return FavoritesPlugin;
  }
}
