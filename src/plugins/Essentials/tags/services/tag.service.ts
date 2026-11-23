import { Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import {
    ID,
    ListQueryBuilder,
    ListQueryOptions,
    PaginatedList,
    Product,
    ProductVariant,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';
import { ProductTag } from '../entities/product-tag.entity';
import { ProductVariantTag } from '../entities/product-variant-tag.entity';
import { CatalogTag } from '../entities/tag.entity';

export type TagMatchMode = 'AND' | 'OR';

const SUGGEST_LIMIT = 20;

@Injectable()
export class TagService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
    ) {}

    /** Canonical normalized key: trimmed + lowercased. Source of truth for dedupe. */
    normalize(raw: string): string {
        const key = (raw ?? '').trim().toLowerCase();
        if (!key) {
            throw new UserInputError('A tag cannot be empty');
        }
        return key;
    }

    /** Autocomplete: prefix match on the indexed `key` (global — every channel). */
    async suggest(ctx: RequestContext, term: string): Promise<CatalogTag[]> {
        const key = (term ?? '').trim().toLowerCase();
        const qb = this.connection
            .getRepository(ctx, CatalogTag)
            .createQueryBuilder('tag')
            .orderBy('tag.value', 'ASC')
            .take(SUGGEST_LIMIT);
        if (key) {
            qb.where('tag.key LIKE :prefix', { prefix: `${key}%` });
        }
        const tags = await qb.getMany();
        return this.attachCounts(ctx, tags);
    }

    /**
     * All tags (global), each enriched with productCount + variantCount.
     */
    async findAll(ctx: RequestContext): Promise<CatalogTag[]> {
        const tags = await this.connection.getRepository(ctx, CatalogTag).find({
            order: { value: 'ASC' },
        });
        return this.attachCounts(ctx, tags);
    }

    /**
     * Attach productCount + variantCount runtime props (surfaced via the
     * non-nullable GraphQL CatalogTag.productCount / variantCount fields).
     * Two grouped count queries total — no N+1. MUST run on every code path
     * that returns CatalogTags to the API, else the resolver throws
     * "Cannot return null for non-nullable field".
     */
    private async attachCounts(ctx: RequestContext, tags: CatalogTag[]): Promise<CatalogTag[]> {
        if (!tags.length) {
            return tags;
        }
        const ids = tags.map(t => t.id);
        const count = async (entity: any, alias: string) =>
            this.connection
                .getRepository(ctx, entity)
                .createQueryBuilder(alias)
                .select(`${alias}.tagId`, 'tagId')
                .addSelect('COUNT(*)', 'c')
                .where(`${alias}.tagId IN (:...ids)`, { ids })
                .groupBy(`${alias}.tagId`)
                .getRawMany<{ tagId: string; c: string }>();
        const [pt, vt] = await Promise.all([count(ProductTag, 'pt'), count(ProductVariantTag, 'vt')]);
        const ptMap = new Map(pt.map(r => [`${r.tagId}`, Number(r.c)]));
        const vtMap = new Map(vt.map(r => [`${r.tagId}`, Number(r.c)]));
        for (const tag of tags) {
            (tag as any).productCount = ptMap.get(`${tag.id}`) ?? 0;
            (tag as any).variantCount = vtMap.get(`${tag.id}`) ?? 0;
        }
        return tags;
    }

    /** Products directly tagged with `tagId`, active channel. */
    async getProductsForTag(ctx: RequestContext, tagId: ID): Promise<Product[]> {
        const rows = await this.connection.getRepository(ctx, ProductTag).find({ where: { tagId } });
        const ids = rows.map(r => r.productId);
        if (!ids.length) {
            return [];
        }
        return this.listQueryBuilder
            .build(Product, {}, { ctx, channelId: ctx.channelId, where: { id: In(ids) } })
            .getMany();
    }

    /** Variants tagged with `tagId`, active channel. */
    async getVariantsForTag(ctx: RequestContext, tagId: ID): Promise<ProductVariant[]> {
        const rows = await this.connection
            .getRepository(ctx, ProductVariantTag)
            .find({ where: { tagId } });
        const ids = rows.map(r => r.variantId);
        if (!ids.length) {
            return [];
        }
        return this.listQueryBuilder
            .build(ProductVariant, {}, { ctx, channelId: ctx.channelId, where: { id: In(ids) } })
            .getMany();
    }

    /**
     * Find an existing tag by normalized key (global), or create it.
     * Race-safe: relies on the unique (key) index — on a concurrent duplicate
     * insert the catch re-fetches the winner.
     */
    async findOrCreate(ctx: RequestContext, value: string): Promise<CatalogTag> {
        const key = this.normalize(value);
        const repo = this.connection.getRepository(ctx, CatalogTag);
        const existing = await repo.findOne({ where: { key } });
        if (existing) {
            return (await this.attachCounts(ctx, [existing]))[0];
        }
        try {
            const created = await repo.save(new CatalogTag({ key, value: value.trim() }));
            return (await this.attachCounts(ctx, [created]))[0];
        } catch (e) {
            const dupe = await repo.findOne({ where: { key } });
            if (dupe) {
                return (await this.attachCounts(ctx, [dupe]))[0];
            }
            throw e;
        }
    }

    async getTagsForProduct(ctx: RequestContext, productId: ID): Promise<CatalogTag[]> {
        const rows = await this.connection.getRepository(ctx, ProductTag).find({
            where: { productId },
            relations: ['tag'],
        });
        const tags = rows.map(r => r.tag);
        return this.attachCounts(ctx, tags);
    }

    async getTagsForVariant(ctx: RequestContext, variantId: ID): Promise<CatalogTag[]> {
        const rows = await this.connection.getRepository(ctx, ProductVariantTag).find({
            where: { variantId },
            relations: ['tag'],
        });
        const tags = rows.map(r => r.tag);
        return this.attachCounts(ctx, tags);
    }

    /** Replace the full set of tags on a Product with `tagIds`. */
    async setProductTags(ctx: RequestContext, productId: ID, tagIds: ID[]): Promise<CatalogTag[]> {
        const validIds = await this.assertTagsExist(ctx, tagIds);
        const repo = this.connection.getRepository(ctx, ProductTag);
        await repo.delete({ productId });
        if (validIds.length) {
            await repo.save(validIds.map(tagId => new ProductTag({ productId, tagId })));
        }
        return this.getTagsForProduct(ctx, productId);
    }

    /** Replace the full set of tags on a ProductVariant with `tagIds`. */
    async setVariantTags(ctx: RequestContext, variantId: ID, tagIds: ID[]): Promise<CatalogTag[]> {
        const validIds = await this.assertTagsExist(ctx, tagIds);
        const repo = this.connection.getRepository(ctx, ProductVariantTag);
        await repo.delete({ variantId });
        if (validIds.length) {
            await repo.save(validIds.map(tagId => new ProductVariantTag({ variantId, tagId })));
        }
        return this.getTagsForVariant(ctx, variantId);
    }

    async deleteTag(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const repo = this.connection.getRepository(ctx, CatalogTag);
        const tag = await repo.findOne({ where: { id } });
        if (!tag) {
            return { result: DeletionResult.NOT_DELETED, message: 'Tag not found' };
        }
        // Join rows cascade via FK onDelete.
        await repo.remove(tag);
        return { result: DeletionResult.DELETED };
    }

    /**
     * Products that carry any/all of `tagIds` either directly OR on any variant
     * (decision 2A), scoped to the active channel, paginated.
     */
    async getProductsByTag(
        ctx: RequestContext,
        input: { tagIds: ID[]; matchMode?: TagMatchMode; options?: ListQueryOptions<Product> },
    ): Promise<PaginatedList<Product>> {
        const tagIds = (input.tagIds ?? []).map(id => `${id}`);
        if (!tagIds.length) {
            return { items: [], totalItems: 0 };
        }
        const matchMode: TagMatchMode = input.matchMode === 'AND' ? 'AND' : 'OR';

        const ptRows = await this.connection
            .getRepository(ctx, ProductTag)
            .createQueryBuilder('pt')
            .select('pt.productId', 'productId')
            .addSelect('pt.tagId', 'tagId')
            .where('pt.tagId IN (:...tagIds)', { tagIds })
            .getRawMany<{ productId: string; tagId: string }>();

        const vtRows = await this.connection
            .getRepository(ctx, ProductVariantTag)
            .createQueryBuilder('vt')
            .innerJoin(ProductVariant, 'pv', 'pv.id = vt.variantId')
            .select('pv.productId', 'productId')
            .addSelect('vt.tagId', 'tagId')
            .where('vt.tagId IN (:...tagIds)', { tagIds })
            .getRawMany<{ productId: string; tagId: string }>();

        const matched = new Map<string, Set<string>>();
        for (const row of [...ptRows, ...vtRows]) {
            const set = matched.get(row.productId) ?? new Set<string>();
            set.add(`${row.tagId}`);
            matched.set(row.productId, set);
        }

        const required = new Set(tagIds).size;
        const productIds = [...matched.entries()]
            .filter(([, tags]) => (matchMode === 'AND' ? tags.size === required : tags.size > 0))
            .map(([productId]) => productId);

        if (!productIds.length) {
            return { items: [], totalItems: 0 };
        }

        return this.listQueryBuilder
            .build(Product, input.options, {
                ctx,
                channelId: ctx.channelId,
                where: { id: In(productIds) },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    /** Keep only tag ids that exist; silently drop the rest. */
    private async assertTagsExist(ctx: RequestContext, tagIds: ID[]): Promise<ID[]> {
        const ids = (tagIds ?? []).filter(Boolean);
        if (!ids.length) {
            return [];
        }
        const found = await this.connection.getRepository(ctx, CatalogTag).find({
            where: { id: In(ids as any) },
        });
        return found.map(t => t.id);
    }
}
