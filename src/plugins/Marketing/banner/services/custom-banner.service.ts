import { Inject, Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import { CustomFieldsObject, ID, PaginatedList } from '@vendure/common/lib/shared-types';
import {
    Asset,
    AssetService,
    CacheService,
    CustomFieldRelationService,
    ForbiddenError,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    RelationPaths,
    RequestContext,
    TransactionalConnection,
    UserInputError,
    assertFound
} from '@vendure/core';
import { BANNER_PLUGIN_OPTIONS } from '../constants';
import { CustomBanner } from '../entities/custom-banner.entity';
import { PluginInitOptions } from '../types';
import { In } from 'typeorm';

const BANNER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const BANNER_TAG_ALL = 'banner:all';
const bannerChannelTag = (channelId: ID | string) => `banner:channel:${channelId}`;
const bannerCacheKey = (channelId: ID | string) => `banner:channel:${channelId}`;

interface CreateCustomBannerInput {
    assetIds?: ID[];
    customFields?: CustomFieldsObject;
}

interface UpdateCustomBannerInput {
    id: ID;
    assetIds?: ID[];
    customFields?: CustomFieldsObject;
}

@Injectable()
export class CustomBannerService {
   
    constructor(
        private connection: TransactionalConnection,
        private assetService: AssetService,
        private listQueryBuilder: ListQueryBuilder,
        private customFieldRelationService: CustomFieldRelationService,
        private cacheService: CacheService,
        @Inject(BANNER_PLUGIN_OPTIONS) private options: PluginInitOptions
    ) { }

   async findByChannel(ctx: RequestContext, channelId: string): Promise<CustomBanner[]> {
    const cacheKey = bannerCacheKey(channelId);
    const cached = (await this.cacheService.get(cacheKey)) as CustomBanner[] | undefined;
    if (cached) {
        return cached;
    }
    const banners = await this.connection.getRepository(ctx, CustomBanner).find({
        relations: ['channels'],
        where: {
            channels: { id: channelId },
        },
    });
    await this.cacheService.set(cacheKey, banners as any, {
        ttl: BANNER_CACHE_TTL_MS,
        tags: [BANNER_TAG_ALL, bannerChannelTag(channelId)],
    });
    return banners;
}

private async invalidateChannelCache(channelId: ID | string): Promise<void> {
    await this.cacheService.invalidateTags([bannerChannelTag(channelId)]);
    Logger.debug(`[CustomBannerService] Cache invalidated for channel ${channelId}`);
}

    

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<CustomBanner> & { channelId?: ID },
        relations?: RelationPaths<CustomBanner>,
    ): Promise<PaginatedList<CustomBanner>> {
        const whereCondition = options?.channelId
            ? { channels: { id: options.channelId } } // Query banners for a specific channel
            : { channels: { id: ctx.channelId } }; // Default to current channel
    
        return this.listQueryBuilder
            .build(CustomBanner, options, {
                relations: [...(relations || []), 'channels'],
                ctx,
                where: whereCondition,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }
    

    findOne(
        ctx: RequestContext,
        id: ID,
        relations?: RelationPaths<CustomBanner>,
    ): Promise<CustomBanner | null> {
        return this.connection.getRepository(ctx, CustomBanner).findOne({
            where: { id },
            relations: [...(relations || []), 'channels'],
        });
    }

    async create(ctx: RequestContext, input: CreateCustomBannerInput): Promise<CustomBanner> {
        const newBanner = new CustomBanner();

        if (input.assetIds && input.assetIds.length > 0) {
            const assetList = await this.assetService.findAll(ctx, {
                filter: { id: { in: input.assetIds.map(String) } }
            });
            newBanner.assets = assetList.items;
        }

        newBanner.channels = [ctx.channel];

        const savedBanner = await this.connection.getRepository(ctx, CustomBanner).save(newBanner);

        await this.invalidateChannelCache(ctx.channelId);
        return assertFound(this.findOne(ctx, savedBanner.id));
    }

    async update(ctx: RequestContext, input: UpdateCustomBannerInput): Promise<CustomBanner> {
        const banner = await this.connection.getEntityOrThrow(ctx, CustomBanner, input.id, { relations: ['channels'] });

        if (!banner) {
            throw new UserInputError(`CustomBanner with id ${input.id} not found`);
        }

        if (!banner.channels) {
            throw new InternalServerError(`Channels are not loaded for the CustomBanner with id ${input.id}`);
        }

        if (!banner.channels.some(channel => channel.id === ctx.channelId)) {
            throw new ForbiddenError();
        }

        if (input.assetIds && input.assetIds.length > 0) {
            const assetList = await this.assetService.findAll(ctx, {
                filter: { id: { in: input.assetIds.map(String) } }
            });
            banner.assets = assetList.items;
        }

        await this.connection.getRepository(ctx, CustomBanner).save(banner);

        await this.invalidateChannelCache(ctx.channelId);
        return assertFound(this.findOne(ctx, banner.id));
    }

    async delete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const banner = await this.connection.getRepository(ctx, CustomBanner).findOne({
            where: { id },
            relations: ['channels'],
        });

        if (!banner) {
            throw new UserInputError(`CustomBanner with id ${id} not found`);
        }

        if (!banner.channels) {
            throw new InternalServerError(`Channels are not loaded for the CustomBanner with id ${id}`);
        }

        if (!banner.channels.some(channel => channel.id === ctx.channelId)) {
            throw new ForbiddenError();
        }

        try {
            await this.connection.getRepository(ctx, CustomBanner).remove(banner);
            await this.invalidateChannelCache(ctx.channelId);
            return { result: DeletionResult.DELETED };
        } catch (e: any) {
            return { result: DeletionResult.NOT_DELETED, message: e.toString() };
        }
    }
}
