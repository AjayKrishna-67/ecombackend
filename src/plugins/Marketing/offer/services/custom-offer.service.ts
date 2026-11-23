import { Inject, Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import {
    AssetService,
    CacheService,
    Collection,
    CollectionService,
    ForbiddenError,
    InternalServerError,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    Product,
    ProductService,
    ProductVariant,
    ProductVariantService,
    RelationPaths,
    RequestContext,
    TransactionalConnection,
    UserInputError,
    assertFound,
} from '@vendure/core';
import { OFFER_PLUGIN_OPTIONS } from '../constants';
import { CustomOffer } from '../entities/custom-offer.entity';
import { PluginInitOptions } from '../types';

const OFFER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const OFFER_TAG_ALL = 'offer:all';
const offerChannelTag = (channelId: ID | string) => `offer:channel:${channelId}`;
const offerCacheKey = (channelId: ID | string) => `offer:byChannel:${channelId}`;

interface CreateCustomOfferInput {
    assetId: ID;
    productId?: ID | null;
    collectionId?: ID | null;
    productVariantId?: ID | null;
    isPreview?: boolean;
}

interface UpdateCustomOfferInput {
    id: ID;
    assetId?: ID | null;
    productId?: ID | null;
    collectionId?: ID | null;
    productVariantId?: ID | null;
    isPreview?: boolean;
}

const OFFER_RELATIONS = ['asset', 'product', 'collection', 'productVariant', 'channels'];

@Injectable()
export class CustomOfferService {
    constructor(
        private connection: TransactionalConnection,
        private assetService: AssetService,
        private productService: ProductService,
        private collectionService: CollectionService,
        private productVariantService: ProductVariantService,
        private listQueryBuilder: ListQueryBuilder,
        private cacheService: CacheService,
        @Inject(OFFER_PLUGIN_OPTIONS) private options: PluginInitOptions,
    ) {}

    async findByChannel(ctx: RequestContext, channelId: string): Promise<CustomOffer[]> {
        const cacheKey = offerCacheKey(channelId);
        const cached = (await this.cacheService.get(cacheKey)) as CustomOffer[] | undefined;
        if (cached) {
            return cached;
        }
        const offers = await this.connection.getRepository(ctx, CustomOffer).find({
            relations: OFFER_RELATIONS,
            where: { channels: { id: channelId }, isPreview: true },
        });
        const result = offers.filter(o => this.isTargetEnabled(o));
        await this.cacheService.set(cacheKey, result as any, {
            ttl: OFFER_CACHE_TTL_MS,
            tags: [OFFER_TAG_ALL, offerChannelTag(channelId)],
        });
        return result;
    }

    private async invalidateChannelCache(channelId: ID | string): Promise<void> {
        await this.cacheService.invalidateTags([offerChannelTag(channelId)]);
        Logger.debug(`[CustomOfferService] Cache invalidated for channel ${channelId}`);
    }

    /**
     * Atomic rotation: returns the next still-available offer in the active
     * channel and flips its `isAvailable` flag to false. When every offer in
     * the channel has already been served (all flags false), the entire
     * channel is reset back to true and the cycle starts over.
     *
     * Returns null only if the channel has no offers at all.
     */
    async getNextOfferForRotation(ctx: RequestContext): Promise<CustomOffer | null> {
        const repo = this.connection.getRepository(ctx, CustomOffer);
        const channelId = ctx.channelId;

        // 1. Try to grab one currently-available offer (oldest first → fair).
        //    Filter out offers linked to disabled products/collections/variants.
        let candidate = await this.findNextEnabledOffer(ctx, channelId);

        // 2. None available — reset the cycle for this channel and try again.
        if (!candidate) {
            const totalForChannel = await repo.count({
                where: { channels: { id: channelId }, isPreview: true },
            });
            if (totalForChannel === 0) {
                return null;
            }
            await this.resetRotationForChannel(ctx, channelId);
            candidate = await this.findNextEnabledOffer(ctx, channelId);
            if (!candidate) {
                return null;
            }
        }

        // 3. Mark the chosen offer as already-served.
        await repo.update(candidate.id, { isAvailable: false });
        candidate.isAvailable = false;
        return candidate;
    }

    /**
     * Flip every offer in the active channel back to isAvailable=true.
     * Returns the number of rows affected.
     */
    async resetRotation(ctx: RequestContext): Promise<number> {
        return this.resetRotationForChannel(ctx, ctx.channelId);
    }

    private async resetRotationForChannel(ctx: RequestContext, channelId: ID): Promise<number> {
        // Update only rows linked to this channel via the ManyToMany join
        // table, without overwriting any other state. UpdateQueryBuilder has
        // no subQuery() helper, so we inline the SELECT as a string fragment.
        const result = await this.connection
            .getRepository(ctx, CustomOffer)
            .createQueryBuilder()
            .update()
            .set({ isAvailable: true })
            .where(
                'id IN (SELECT link.customOfferId FROM custom_offer_channels_channel link WHERE link.channelId = :channelId)',
                { channelId },
            )
            .execute();
        return result.affected ?? 0;
    }

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<CustomOffer>,
        relations?: RelationPaths<CustomOffer>,
    ): Promise<PaginatedList<CustomOffer>> {
        return this.listQueryBuilder
            .build(CustomOffer, options, {
                relations: [...(relations || []), ...OFFER_RELATIONS],
                ctx,
                where: { channels: { id: ctx.channelId } },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    findOne(
        ctx: RequestContext,
        id: ID,
        relations?: RelationPaths<CustomOffer>,
    ): Promise<CustomOffer | null> {
        return this.connection.getRepository(ctx, CustomOffer).findOne({
            where: { id },
            relations: [...(relations || []), ...OFFER_RELATIONS],
        });
    }

    async create(ctx: RequestContext, input: CreateCustomOfferInput): Promise<CustomOffer> {
        if (!input.assetId) {
            throw new UserInputError('An offer must have exactly one image (assetId is required)');
        }

        // Link is optional — caller may supply zero or one target.
        const target = this.assertAtMostOneTarget(input);

        const asset = await this.assetService.findOne(ctx, input.assetId);
        if (!asset) {
            throw new UserInputError(`Asset with id ${input.assetId} not found`);
        }

        const offer = new CustomOffer();
        offer.asset = asset;
        offer.product = null;
        offer.collection = null;
        offer.productVariant = null;
        offer.channels = [ctx.channel];
        offer.isPreview = input.isPreview ?? false;

        if (target) {
            await this.attachTarget(ctx, offer, target);
        }

        const saved = await this.connection.getRepository(ctx, CustomOffer).save(offer);
        await this.invalidateChannelCache(ctx.channelId);
        return assertFound(this.findOne(ctx, saved.id));
    }

    async update(ctx: RequestContext, input: UpdateCustomOfferInput): Promise<CustomOffer> {
        const offer = await this.connection.getEntityOrThrow(ctx, CustomOffer, input.id, {
            relations: OFFER_RELATIONS,
        });

        if (!offer.channels || !offer.channels.some(c => c.id === ctx.channelId)) {
            throw new ForbiddenError();
        }

        if (input.assetId) {
            const asset = await this.assetService.findOne(ctx, input.assetId);
            if (!asset) {
                throw new UserInputError(`Asset with id ${input.assetId} not found`);
            }
            offer.asset = asset;
        }

        // If any target id was supplied (including explicit null), re-evaluate
        // the XOR constraint and reattach.
        const targetSupplied =
            input.productId !== undefined ||
            input.collectionId !== undefined ||
            input.productVariantId !== undefined;

        if (input.isPreview !== undefined) {
            offer.isPreview = input.isPreview;
        }

        if (targetSupplied) {
            const target = this.assertAtMostOneTarget({
                productId: input.productId ?? null,
                collectionId: input.collectionId ?? null,
                productVariantId: input.productVariantId ?? null,
            });
            offer.product = null;
            offer.collection = null;
            offer.productVariant = null;
            if (target) {
                await this.attachTarget(ctx, offer, target);
            }
        }

        await this.connection.getRepository(ctx, CustomOffer).save(offer);
        await this.invalidateChannelCache(ctx.channelId);
        return assertFound(this.findOne(ctx, offer.id));
    }

    async delete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const offer = await this.connection.getRepository(ctx, CustomOffer).findOne({
            where: { id },
            relations: ['channels'],
        });

        if (!offer) {
            throw new UserInputError(`CustomOffer with id ${id} not found`);
        }

        if (!offer.channels) {
            throw new InternalServerError(`Channels are not loaded for the CustomOffer with id ${id}`);
        }

        if (!offer.channels.some(channel => channel.id === ctx.channelId)) {
            throw new ForbiddenError();
        }

        try {
            await this.connection.getRepository(ctx, CustomOffer).remove(offer);
            await this.invalidateChannelCache(ctx.channelId);
            return { result: DeletionResult.DELETED };
        } catch (e: any) {
            return { result: DeletionResult.NOT_DELETED, message: e.toString() };
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /**
     * Validates that AT MOST ONE of productId / collectionId / productVariantId
     * was supplied. Returns the descriptor if one was supplied, or null if
     * none were (the offer is link-less). Throws if more than one was given.
     */
    private assertAtMostOneTarget(input: {
        productId?: ID | null;
        collectionId?: ID | null;
        productVariantId?: ID | null;
    }): { kind: 'product' | 'collection' | 'variant'; id: ID } | null {
        const present: Array<{ kind: 'product' | 'collection' | 'variant'; id: ID }> = [];
        if (input.productId) present.push({ kind: 'product', id: input.productId });
        if (input.collectionId) present.push({ kind: 'collection', id: input.collectionId });
        if (input.productVariantId) present.push({ kind: 'variant', id: input.productVariantId });

        if (present.length > 1) {
            throw new UserInputError(
                'An offer can target at most ONE of productId / collectionId / productVariantId, not multiple',
            );
        }
        return present[0] ?? null;
    }

    /**
     * Returns true if the offer has no target (image-only) or if the linked
     * product/collection/variant is enabled (i.e. not disabled/private).
     *
     * - Product: `enabled` must be true
     * - Collection: `isPrivate` must be false
     * - ProductVariant: `enabled` must be true
     */
    /**
     * Find the next available offer in the channel with an enabled target.
     */
    private async findNextEnabledOffer(ctx: RequestContext, channelId: ID): Promise<CustomOffer | null> {
        const repo = this.connection.getRepository(ctx, CustomOffer);
        // Fetch a batch of available offers and pick the first enabled one.
        // This avoids the issue where a single findOne might grab a
        // disabled-target offer and skip it, leaving the rest unserved.
        const candidates = await repo.find({
            where: { isAvailable: true, isPreview: true, channels: { id: channelId } },
            relations: OFFER_RELATIONS,
            order: { updatedAt: 'ASC', id: 'ASC' },
        });
        return candidates.find(o => this.isTargetEnabled(o)) ?? null;
    }

    private isTargetEnabled(offer: CustomOffer): boolean {
        if (offer.product) return (offer.product as any).enabled !== false;
        if (offer.collection) return (offer.collection as any).isPrivate !== true;
        if (offer.productVariant) return (offer.productVariant as any).enabled !== false;
        // No target — image-only offer, always show.
        return true;
    }

    private async attachTarget(
        ctx: RequestContext,
        offer: CustomOffer,
        target: { kind: 'product' | 'collection' | 'variant'; id: ID },
    ): Promise<void> {
        if (target.kind === 'product') {
            const product = await this.productService.findOne(ctx, target.id);
            if (!product) {
                throw new UserInputError(`Product with id ${target.id} not found`);
            }
            offer.product = product as Product;
        } else if (target.kind === 'collection') {
            const collection = await this.collectionService.findOne(ctx, target.id);
            if (!collection) {
                throw new UserInputError(`Collection with id ${target.id} not found`);
            }
            offer.collection = collection as Collection;
        } else {
            const variant = await this.productVariantService.findOne(ctx, target.id);
            if (!variant) {
                throw new UserInputError(`ProductVariant with id ${target.id} not found`);
            }
            offer.productVariant = variant as ProductVariant;
        }
    }
}
