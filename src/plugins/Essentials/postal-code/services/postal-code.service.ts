import { Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import {
    CacheService,
    ForbiddenError,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    RelationPaths,
    RequestContext,
    TransactionalConnection,
    UserInputError,
    assertFound,
    Logger
} from '@vendure/core';
import { PostalCode } from '../entities/postal-code.entity';
import { PostalCodeArea } from '../entities/postal-code-area.entity';

interface CachedPostalCode {
    code: string;
    areas: string[];
    allAreas: Array<{ name: string; enabled: boolean }>;
}

interface ChannelCacheEntry {
    mode: 'anywhere' | 'custom';
    postalCodes: CachedPostalCode[];
}

const POSTAL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const POSTAL_TAG_ALL = 'postal-codes:all';
const postalChannelTag = (channelId: ID) => `postal-codes:channel:${channelId}`;
const postalCacheKey = (channelId: ID) => `postal-codes:channel:${channelId}`;

interface CreatePostalCodeInput {
    code: string;
    isAnywhere?: boolean;
}

interface UpdatePostalCodeInput {
    id: ID;
    code?: string;
    isAnywhere?: boolean;
}

interface CreatePostalCodeAreaInput {
    postalCodeId: ID;
    name: string;
}

interface UpdatePostalCodeAreaInput {
    id: ID;
    name?: string;
    enabled?: boolean;
}

@Injectable()
export class PostalCodeService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private cacheService: CacheService,
    ) {
        Logger.info('[PostalCodeService] Initialized with Redis-backed caching (areas enabled)');
    }

    // ─── PostalCode CRUD ────────────────────────────────────────────

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<PostalCode> & { channelId?: ID },
        relations?: RelationPaths<PostalCode>,
    ): Promise<PaginatedList<PostalCode>> {
        const whereCondition = options?.channelId
            ? { channels: { id: options.channelId } }
            : { channels: { id: ctx.channelId } };
        return this.listQueryBuilder
            .build(PostalCode, options, {
                relations: [...(relations || []), 'channels', 'areas'],
                ctx,
                where: whereCondition,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    findOne(
        ctx: RequestContext,
        id: ID,
        relations?: RelationPaths<PostalCode>,
    ): Promise<PostalCode | null> {
        return this.connection.getRepository(ctx, PostalCode).findOne({
            where: { id },
            relations: [...(relations || []), 'channels', 'areas'],
        });
    }

    async create(ctx: RequestContext, input: CreatePostalCodeInput): Promise<PostalCode> {
        if (input.isAnywhere) {
            const existingAnywhere = await this.connection.getRepository(ctx, PostalCode).findOne({
                where: { isAnywhere: true, channels: { id: ctx.channelId } },
                relations: ['channels']
            });
            if (existingAnywhere) {
                throw new UserInputError('An "Anywhere" postal code configuration already exists for this channel');
            }
        }
        const newPostalCode = new PostalCode();
        newPostalCode.code = input.code;
        newPostalCode.isAnywhere = input.isAnywhere || false;
        newPostalCode.channels = [ctx.channel];
        const savedPostalCode = await this.connection.getRepository(ctx, PostalCode).save(newPostalCode);
        await this.clearCache(ctx.channelId);
        return assertFound(this.findOne(ctx, savedPostalCode.id));
    }

    async update(ctx: RequestContext, input: UpdatePostalCodeInput): Promise<PostalCode> {
        const postalCode = await this.connection.getEntityOrThrow(ctx, PostalCode, input.id, {
            relations: ['channels']
        });
        if (!postalCode.channels) {
            throw new InternalServerError(`Channels are not loaded for the PostalCode with id ${input.id}`);
        }
        if (!postalCode.channels.some(channel => channel.id === ctx.channelId)) {
            throw new ForbiddenError();
        }
        if (input.isAnywhere && !postalCode.isAnywhere) {
            const existingAnywhere = await this.connection.getRepository(ctx, PostalCode).findOne({
                where: { isAnywhere: true, channels: { id: ctx.channelId } },
                relations: ['channels']
            });
            if (existingAnywhere && existingAnywhere.id !== input.id) {
                throw new UserInputError('An "Anywhere" postal code configuration already exists for this channel');
            }
        }
        if (input.code !== undefined) {
            postalCode.code = input.code;
        }
        if (input.isAnywhere !== undefined) {
            postalCode.isAnywhere = input.isAnywhere;
        }
        await this.connection.getRepository(ctx, PostalCode).save(postalCode);
        await this.clearCache(ctx.channelId);
        return assertFound(this.findOne(ctx, postalCode.id));
    }

    async delete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const postalCode = await this.connection.getRepository(ctx, PostalCode).findOne({
            where: { id },
            relations: ['channels'],
        });
        if (!postalCode) {
            throw new UserInputError(`PostalCode with id ${id} not found`);
        }
        if (!postalCode.channels) {
            throw new InternalServerError(`Channels are not loaded for the PostalCode with id ${id}`);
        }
        if (!postalCode.channels.some(channel => channel.id === ctx.channelId)) {
            throw new ForbiddenError();
        }
        try {
            await this.connection.getRepository(ctx, PostalCode).remove(postalCode);
            await this.clearCache(ctx.channelId);
            return { result: DeletionResult.DELETED };
        } catch (e: any) {
            return { result: DeletionResult.NOT_DELETED, message: e.toString() };
        }
    }

    // ─── Area CRUD ──────────────────────────────────────────────────

    async findAreasByPostalCode(ctx: RequestContext, postalCodeId: ID): Promise<PostalCodeArea[]> {
        return this.connection.getRepository(ctx, PostalCodeArea).find({
            where: { postalCode: { id: postalCodeId } },
            relations: ['postalCode'],
            order: { name: 'ASC' },
        });
    }

    async findAllAreas(ctx: RequestContext): Promise<PostalCodeArea[]> {
        return this.connection.getRepository(ctx, PostalCodeArea).find({
            where: { postalCode: { channels: { id: ctx.channelId } } },
            relations: ['postalCode'],
            order: { name: 'ASC' },
        });
    }

    async createArea(ctx: RequestContext, input: CreatePostalCodeAreaInput): Promise<PostalCodeArea> {
        const postalCode = await this.connection.getEntityOrThrow(ctx, PostalCode, input.postalCodeId, {
            relations: ['channels'],
        });
        if (!postalCode.channels?.some(ch => ch.id === ctx.channelId)) {
            throw new ForbiddenError();
        }
        const trimmedName = input.name.trim();
        const existing = await this.connection.getRepository(ctx, PostalCodeArea).findOne({
            where: { name: trimmedName, postalCode: { id: input.postalCodeId } },
        });
        if (existing) {
            throw new UserInputError(`Area "${trimmedName}" already exists for this postal code`);
        }
        const area = new PostalCodeArea({ name: trimmedName, enabled: true, postalCode });
        const saved = await this.connection.getRepository(ctx, PostalCodeArea).save(area);
        await this.clearCache(ctx.channelId);
        return saved;
    }

    async updateArea(ctx: RequestContext, input: UpdatePostalCodeAreaInput): Promise<PostalCodeArea> {
        const area = await this.connection.getRepository(ctx, PostalCodeArea).findOne({
            where: { id: input.id },
            relations: ['postalCode', 'postalCode.channels'],
        });
        if (!area) {
            throw new UserInputError(`PostalCodeArea with id ${input.id} not found`);
        }
        if (!area.postalCode.channels?.some(ch => ch.id === ctx.channelId)) {
            throw new ForbiddenError();
        }
        if (input.name !== undefined) {
            const trimmedName = input.name.trim();
            const duplicate = await this.connection.getRepository(ctx, PostalCodeArea).findOne({
                where: { name: trimmedName, postalCode: { id: area.postalCode.id } },
            });
            if (duplicate && duplicate.id !== input.id) {
                throw new UserInputError(`Area "${trimmedName}" already exists for this postal code`);
            }
            area.name = trimmedName;
        }
        if (input.enabled !== undefined) {
            area.enabled = input.enabled;
        }
        const saved = await this.connection.getRepository(ctx, PostalCodeArea).save(area);
        await this.clearCache(ctx.channelId);
        return saved;
    }

    async deleteArea(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const area = await this.connection.getRepository(ctx, PostalCodeArea).findOne({
            where: { id },
            relations: ['postalCode', 'postalCode.channels'],
        });
        if (!area) {
            throw new UserInputError(`PostalCodeArea with id ${id} not found`);
        }
        if (!area.postalCode.channels?.some(ch => ch.id === ctx.channelId)) {
            throw new ForbiddenError();
        }
        try {
            await this.connection.getRepository(ctx, PostalCodeArea).remove(area);
            await this.clearCache(ctx.channelId);
            return { result: DeletionResult.DELETED };
        } catch (e: any) {
            return { result: DeletionResult.NOT_DELETED, message: e.toString() };
        }
    }

    // ─── Cache ──────────────────────────────────────────────────────

    /**
     * A postal-code edit changes the answer for more than the channel that made it: the
     * channel-availability cache tags its entries with POSTAL_TAG_ALL and answers
     * cross-channel questions ("which of this brand's channels serves 625001?"). Moving a
     * code between channels therefore has to invalidate the shared tag as well as this
     * plugin's own per-channel key — invalidating only the editing channel left
     * brandChannels serving the pre-edit answer until its TTL expired.
     */
    private async clearCache(channelId?: ID): Promise<void> {
        if (channelId) {
            await this.cacheService.delete(postalCacheKey(channelId));
        }
        await this.cacheService.invalidateTags([POSTAL_TAG_ALL]);
        Logger.debug(
            `[PostalCodeService] Cache cleared${channelId ? ` for channel ${channelId}` : ''} + ${POSTAL_TAG_ALL}`,
        );
    }

    private async getCachedValidationData(ctx: RequestContext): Promise<ChannelCacheEntry> {
        const cacheKey = postalCacheKey(ctx.channelId);
        const cached = (await this.cacheService.get(cacheKey)) as ChannelCacheEntry | undefined;
        if (cached) {
            return cached;
        }
        Logger.debug(`[PostalCodeService] Cache miss for channel ${ctx.channelId}, fetching from DB`);
        const result = await this.findAll(ctx);
        const postalCodes = result.items;
        const anywhereConfig = postalCodes.find(pc => pc.isAnywhere);
        let cacheEntry: ChannelCacheEntry;
        if (anywhereConfig) {
            cacheEntry = { mode: 'anywhere', postalCodes: [] };
        } else {
            const cachedList = postalCodes
                .filter(pc => !pc.isAnywhere)
                .map(pc => ({
                    code: pc.code,
                    areas: (pc.areas || []).filter(a => a.enabled).map(a => a.name),
                    allAreas: (pc.areas || []).map(a => ({ name: a.name, enabled: a.enabled })),
                }));
            cacheEntry = { mode: 'custom', postalCodes: cachedList };
        }
        await this.cacheService.set(cacheKey, cacheEntry as any, {
            ttl: POSTAL_CACHE_TTL_MS,
            tags: [POSTAL_TAG_ALL, postalChannelTag(ctx.channelId)],
        });
        Logger.info(
            `[PostalCodeService] Cached ${cacheEntry.mode} mode with ` +
            `${cacheEntry.postalCodes.length} postal codes for channel ${ctx.channelId}`
        );
        return cacheEntry;
    }

    // ─── Validation ─────────────────────────────────────────────────

    /**
     * Validates a postal code and optionally its area for the current channel.
     * Uses channel-aware caching — first call ~50ms (DB), subsequent ~1ms (cache).
     */
    async validatePostalCode(
        ctx: RequestContext,
        postalCode: string | null | undefined,
        area?: string | null,
    ): Promise<void> {
        if (!postalCode) return;
        const validationData = await this.getCachedValidationData(ctx);
        if (validationData.mode === 'anywhere') return;
        const match = validationData.postalCodes.find(pc => pc.code === postalCode);
        if (!match) {
            throw new UserInputError(
                `Invalid postal code "${postalCode}". Please select a valid postal code from the available options.`
            );
        }
        if (area && match.allAreas.length > 0 && !match.areas.includes(area)) {
            const disabledArea = match.allAreas.find(a => a.name === area && !a.enabled);
            if (disabledArea) {
                throw new UserInputError(
                    `Service is currently unavailable for "${area}" in postal code "${postalCode}".`
                );
            }
            throw new UserInputError(
                `Invalid area "${area}" for postal code "${postalCode}". Please select a valid area.`
            );
        }
    }
}
