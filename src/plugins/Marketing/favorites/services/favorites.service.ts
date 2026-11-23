import { Injectable } from '@nestjs/common';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import {
    CacheService,
    ChannelService,
    CustomerService,
    ForbiddenError,
    HistoryService,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    ProductService,
    RelationPaths,
    RequestContext,
    TransactionalConnection,
    Customer,
} from '@vendure/core';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { Favorite } from '../entities/favorite.entity';
import { loggerCtx } from '../constants';

const FAV_CACHE_TTL_MS = 60_000; // 1 minute — invalidation on mutation makes this safe
const FAV_TAG_ALL = 'favorites:all';
const favChannelTag = (channelId: ID) => `favorites:channel:${channelId}`;
const favUserTag = (channelId: ID, customerId: ID) =>
    `favorites:channel:${channelId}:customer:${customerId}`;
const favCacheKey = (channelId: ID, customerId: ID) =>
    `favorites:${channelId}:${customerId}`;

@Injectable()
export class FavoritesService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private channelService: ChannelService,
        private customerService: CustomerService,
        private productService: ProductService,
        private historyService: HistoryService,
        private cacheService: CacheService,
    ) {
        Logger.info('[FavoritesService] Initialized with Redis-backed caching', loggerCtx);
    }

    /**
     * Get paginated favorites for a customer in the current channel
     */
    findAll(
        ctx: RequestContext,
        customerId: ID,
        options?: ListQueryOptions<Favorite>,
        relations?: RelationPaths<Favorite>,
    ): Promise<PaginatedList<Favorite>> {
        return this.listQueryBuilder
            .build(Favorite, options, {
                relations: [...(relations || []), 'channels', 'product', 'product.featuredAsset', 'customer'],
                ctx,
                where: {
                    customer: { id: customerId },
                    channels: { id: ctx.channelId },
                },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    /**
     * Get paginated favorites with product name filter
     */
    async findAllWithFilter(
        ctx: RequestContext,
        customerId: ID,
        options?: ListQueryOptions<Favorite>,
        productNameFilter?: string,
    ): Promise<PaginatedList<Favorite>> {
        const qb = this.listQueryBuilder
            .build(Favorite, options, {
                relations: ['channels', 'product', 'product.featuredAsset'],
                ctx,
                where: {
                    customer: { id: customerId },
                    channels: { id: ctx.channelId },
                },
            });

        if (productNameFilter) {
            // Get the main alias used by the query builder
            const favoriteAlias = qb.alias;
            qb.leftJoin(`${favoriteAlias}.product`, 'filtered_product')
              .leftJoin('filtered_product.translations', 'product_translation')
              .andWhere('product_translation.languageCode = :languageCode', {
                  languageCode: ctx.languageCode,
              })
              .andWhere('LOWER(product_translation.name) LIKE :name', {
                  name: `%${productNameFilter.toLowerCase().trim()}%`,
              });
        }

        return qb.getManyAndCount().then(([items, totalItems]) => ({ items, totalItems }));
    }

    /**
     * Get a single favorite by ID with channel check
     */
    async findOne(
        ctx: RequestContext,
        id: ID,
        relations?: RelationPaths<Favorite>,
    ): Promise<Favorite | null> {
        const favorite = await this.connection.getRepository(ctx, Favorite).findOne({
            where: {
                id,
                channels: { id: ctx.channelId },
            },
            relations: [...(relations || []), 'channels', 'product', 'customer'],
        });
        return favorite ?? null;
    }

    /**
     * Toggle a product's favorite status for the current customer and channel
     */
    async toggleFavorite(
        ctx: RequestContext,
        productId: ID,
        trackHistory: boolean = false,
    ): Promise<PaginatedList<Favorite>> {
        const customer = await this.getCustomerForOwner(ctx);

        Logger.verbose(`Toggling favorite for product ${productId} by customer ${customer.id} in channel ${ctx.channelId}`, loggerCtx);

        const existingFavorite = await this.connection.getRepository(ctx, Favorite).findOne({
            where: {
                product: { id: productId },
                customer: { id: customer.id },
                channels: { id: ctx.channelId },
            },
            relations: ['channels', 'product'],
        });

        let operation: 'added' | 'removed';
        let productName: string | undefined;

        if (existingFavorite) {
            await this.removeFavoriteFromChannel(ctx, existingFavorite);
            operation = 'removed';
            productName = existingFavorite.product?.name;
        } else {
            await this.addFavoriteToChannel(ctx, customer.id, productId);
            operation = 'added';
        }

        await this.clearCache(ctx.channelId, customer.id);

        if (!productName) {
            const product = await this.productService.findOne(ctx, productId);
            productName = product?.name;
        }

        if (trackHistory && productName) {
            await this.historyService.createHistoryEntryForCustomer({
                ctx,
                customerId: customer.id,
                type: HistoryEntryType.CUSTOMER_NOTE,
                data: {
                    note: `Customer ${operation} "${productName}" to favorites in channel ${ctx.channel.code}.`,
                },
            }, false);
        }

        Logger.verbose(`Favorite ${operation} successfully. Returning updated list.`, loggerCtx);

        return this.findAll(ctx, customer.id);
    }

    /**
     * Check if a product is favorited by a customer in the current channel (with caching)
     */
    async isFavorite(
        ctx: RequestContext,
        customerId: ID,
        productId: ID,
    ): Promise<boolean> {
        const cacheKey = favCacheKey(ctx.channelId, customerId);
        const cached = (await this.cacheService.get(cacheKey)) as string[] | undefined;

        if (cached) {
            Logger.debug(`[FavoritesService] Cache hit for ${cacheKey}`, loggerCtx);
            return cached.includes(String(productId));
        }

        Logger.debug(`[FavoritesService] Cache miss for ${cacheKey}, fetching from DB`, loggerCtx);
        const favorites = await this.findAll(ctx, customerId);
        const productIds = favorites.items
            .map(f => String(f.product?.id))
            .filter((id): id is string => Boolean(id));

        await this.cacheService.set(cacheKey, productIds, {
            ttl: FAV_CACHE_TTL_MS,
            tags: [
                FAV_TAG_ALL,
                favChannelTag(ctx.channelId),
                favUserTag(ctx.channelId, customerId),
            ],
        });

        return productIds.includes(String(productId));
    }

    /**
     * Get all favorited product IDs for a customer in the current channel
     */
    async getFavoriteProductIds(
        ctx: RequestContext,
        customerId: ID,
    ): Promise<ID[]> {
        const favorites = await this.findAll(ctx, customerId, { take: 1000 });
        return favorites.items.map(f => f.product?.id).filter((id): id is ID => id !== undefined);
    }

    /**
     * Add a product to favorites for the current channel
     */
    private async addFavoriteToChannel(
        ctx: RequestContext,
        customerId: ID,
        productId: ID,
    ): Promise<Favorite> {
        const repo = this.connection.getRepository(ctx, Favorite);

        let favorite = await repo.findOne({
            where: {
                product: { id: productId },
                customer: { id: customerId },
            },
            relations: ['channels'],
        });

        if (favorite) {
            if (!favorite.channels.some(ch => idsAreEqual(ch.id, ctx.channelId))) {
                favorite.channels.push(ctx.channel);
                await repo.save(favorite);
            }
        } else {
            favorite = new Favorite({
                customer: { id: customerId } as Customer,
                product: { id: productId } as any,
            });
            await this.channelService.assignToCurrentChannel(favorite, ctx);
            await repo.save(favorite);
        }

        return favorite;
    }

    /**
     * Remove a product from favorites for the current channel
     */
    private async removeFavoriteFromChannel(
        ctx: RequestContext,
        favorite: Favorite,
    ): Promise<void> {
        const repo = this.connection.getRepository(ctx, Favorite);

        favorite.channels = favorite.channels.filter(ch => !idsAreEqual(ch.id, ctx.channelId));

        if (favorite.channels.length === 0) {
            await repo.remove(favorite);
        } else {
            await repo.save(favorite);
        }
    }

    /**
     * Get the customer associated with the current authenticated user
     */
    async getCustomerForOwner(ctx: RequestContext): Promise<Customer> {
        const userId = ctx.activeUserId;
        if (!userId) {
            throw new ForbiddenError();
        }

        const customer = await this.customerService.findOneByUserId(ctx, userId);
        if (!customer) {
            throw new InternalServerError('No customer found for current user');
        }

        return customer;
    }

    /**
     * Clear cache for a specific customer/channel or all cache
     */
    async clearCache(channelId?: ID, customerId?: ID): Promise<void> {
        if (channelId && customerId) {
            await this.cacheService.delete(favCacheKey(channelId, customerId));
            Logger.debug(`[FavoritesService] Cache cleared for channel ${channelId} customer ${customerId}`, loggerCtx);
        } else if (channelId) {
            await this.cacheService.invalidateTags([favChannelTag(channelId)]);
            Logger.debug(`[FavoritesService] Cache cleared for channel ${channelId}`, loggerCtx);
        } else {
            await this.cacheService.invalidateTags([FAV_TAG_ALL]);
            Logger.debug('[FavoritesService] All cache cleared', loggerCtx);
        }
    }
}

function idsAreEqual(id1: ID, id2: ID): boolean {
    return String(id1) === String(id2);
}
