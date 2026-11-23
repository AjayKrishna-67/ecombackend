import { Injectable } from '@nestjs/common';
import { GlobalFlag, UpdateProductVariantInput } from '@vendure/common/lib/generated-types';
import {
    ConfigService,
    CustomFieldConfig,
    ID,
    LanguageCode,
    ProductVariant,
    ProductVariantService,
    RequestContext,
    StockLevel,
    TaxCategory,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
// Importer is a provider exported by core's DataImportModule (which
// PluginCommonModule re-exports), but it is not part of the public package
// entry point — hence the deep import. It lets us reuse core's full create
// logic while re-gating the mutation to CreateCatalog (see resolver).
import { Importer } from '@vendure/core/dist/data-import/providers/importer/importer';
import { lastValueFrom } from 'rxjs';
import { isCustomFieldTrue } from '../../../Stock/shared/custom-field-boolean';
import { TagService } from '../../tags/services/tag.service';
import {
    buildCsvLine,
    customFieldColumnKey,
    CustomFieldLevel,
    EXPORT_BASE_COLUMNS,
    isExportableCustomFieldType,
    detectDuplicateSkus,
    parseCsv,
    parseIntCell,
    parseTrackInventory,
    priceToMajor,
    priceToMinor,
    stringifyCustomField,
} from './product-csv.helpers';

export interface ImportInfo {
    imported: number;
    processed: number;
    errors: string[];
}

/** One exportable column shown in the field picker. */
export interface ExportField {
    key: string;
    label: string;
    level: CustomFieldLevel;
    type: string;
}

/** Resolved custom-field column used while building an export row. */
interface CustomFieldColumn {
    key: string;
    name: string;
    level: CustomFieldLevel;
    type: string;
    label: string;
}

const MAX_EXPORT_VARIANTS = 5000;

/**
 * Metadata for the fixed (non-custom-field) export columns, in EXPORT_BASE_COLUMNS
 * order. `level` drives the grouped layout: product-level cells are written only
 * on the first row of each product; variant-level cells on every row.
 */
const EXPORT_BASE_FIELD_META: ExportField[] = [
    { key: 'name', label: 'Name', level: 'product', type: 'string' },
    { key: 'variant:name', label: 'Variant Name', level: 'variant', type: 'string' },
    { key: 'slug', label: 'Slug', level: 'product', type: 'string' },
    { key: 'description', label: 'Description', level: 'product', type: 'string' },
    { key: 'product:tags', label: 'Product Tags', level: 'product', type: 'string' },
    { key: 'sku', label: 'SKU', level: 'variant', type: 'string' },
    { key: 'price', label: 'Price', level: 'variant', type: 'string' },
    { key: 'taxCategory', label: 'Tax Category', level: 'variant', type: 'string' },
    { key: 'stockOnHand', label: 'Stock On Hand', level: 'variant', type: 'string' },
    { key: 'trackInventory', label: 'Track Inventory', level: 'variant', type: 'string' },
    { key: 'variant:tags', label: 'Variant Tags', level: 'variant', type: 'string' },
];

@Injectable()
export class ProductCsvService {
    constructor(
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
        private importer: Importer,
        private tagService: TagService,
        private configService: ConfigService,
    ) {}

    /**
     * The full picker field list: fixed base columns + every scalar custom field
     * from config (product then variant). This is the single authority for what
     * can be exported, so the frontend never has to know custom-field rules.
     */
    getExportableFields(ctx: RequestContext): ExportField[] {
        const custom = this.collectCustomFieldColumns(ctx).map(column => ({
            key: column.key,
            label: column.label,
            level: column.level,
            type: column.type,
        }));
        return [...EXPORT_BASE_FIELD_META, ...custom];
    }

    /**
     * Resolve every exportable custom field from ConfigService into column
     * metadata. relation/localeString types are filtered out (can't flatten to
     * one cell). Product fields come before variant fields to match the header.
     */
    private collectCustomFieldColumns(ctx: RequestContext): CustomFieldColumn[] {
        const build = (configs: CustomFieldConfig[], level: CustomFieldLevel): CustomFieldColumn[] =>
            configs
                .filter(config => isExportableCustomFieldType(config.type))
                .map(config => ({
                    key: customFieldColumnKey(level, config.name),
                    name: config.name,
                    level,
                    type: config.type,
                    label: this.resolveFieldLabel(ctx, config),
                }));
        return [
            ...build(this.configService.customFields.Product, 'product'),
            ...build(this.configService.customFields.ProductVariant, 'variant'),
        ];
    }

    private resolveFieldLabel(ctx: RequestContext, config: CustomFieldConfig): string {
        const labels = config.label ?? [];
        const match =
            labels.find(entry => entry.languageCode === ctx.languageCode) ??
            labels.find(entry => entry.languageCode === LanguageCode.en) ??
            labels[0];
        return match?.value ?? config.name;
    }

    /**
     * Export every variant in the active channel as one flat CSV row each
     * (product fields repeated per variant). One self-contained row per SKU
     * means the update re-import never has to associate orphan rows.
     */
    async exportCsv(
        ctx: RequestContext,
        options: { columns?: string[]; productIds?: ID[] } = {},
    ): Promise<string> {
        // Canonical column order = base columns then dynamic custom-field columns.
        // A picker selection filters this list but never reorders it, so the CSV
        // layout stays stable no matter what order the boxes were ticked.
        const customCols = this.collectCustomFieldColumns(ctx);
        const canonicalKeys = [...EXPORT_BASE_COLUMNS, ...customCols.map(column => column.key)];
        const selectedKeys =
            options.columns && options.columns.length > 0
                ? canonicalKeys.filter(key => options.columns!.includes(key))
                : canonicalKeys;
        const header = buildCsvLine(selectedKeys);
        // Two product scopes, in priority order:
        //   1. productIds -> exactly the rows the user ticked (survives any search
        //      filter, since it's an explicit id list, not a re-derived query).
        //   2. none        -> the whole channel catalog (with the 5000 cap).
        const productIdFilter = options.productIds && options.productIds.length > 0 ? options.productIds : null;
        if (productIdFilter && productIdFilter.length === 0) {
            return header + '\n';
        }
        const qb = this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.product', 'product')
            // name/slug/description are translatable -> they live in
            // ProductTranslation, not on the Product row. Without this join they
            // come back undefined.
            .leftJoinAndSelect('product.translations', 'product_translations')
            // variant.name is also translatable -> load variant translations.
            .leftJoinAndSelect('variant.translations', 'variant_translations')
            .leftJoinAndSelect('variant.taxCategory', 'taxCategory')
            // applyChannelPriceAndTax reads variant.productVariantPrices; without
            // this relation it's undefined and selectPrice crashes on .filter().
            .leftJoinAndSelect('variant.productVariantPrices', 'productVariantPrices')
            .leftJoin('variant.channels', 'channel')
            .where('channel.id = :channelId', { channelId: ctx.channelId })
            .andWhere('variant.deletedAt IS NULL')
            .orderBy('variant.productId', 'ASC')
            .addOrderBy('variant.id', 'ASC');
        if (productIdFilter) {
            qb.andWhere('variant.productId IN (:...ids)', { ids: productIdFilter });
        } else {
            // Only the "all products" path needs the safety cap.
            const total = await qb.getCount();
            if (total > MAX_EXPORT_VARIANTS) {
                throw new UserInputError(
                    `Export is limited to ${MAX_EXPORT_VARIANTS} variants (found ${total}). Select specific products instead, or narrow the catalog.`,
                );
            }
        }
        const variants = await qb.getMany();
        const lines: string[] = [header];
        // Variants are ordered by productId, so the first row of each run of the
        // same product carries the product-level fields (Shopify grouped layout);
        // the rest leave them blank = inherit.
        const productTagsCache = new Map<ID, string>();
        let previousProductId: ID | undefined;
        for (const variant of variants) {
            await this.productVariantService.applyChannelPriceAndTax(variant, ctx, undefined, false);
            const isFirstOfProduct = variant.productId !== previousProductId;
            previousProductId = variant.productId;
            if (!productTagsCache.has(variant.productId)) {
                const tags = await this.tagService.getTagsForProduct(ctx, variant.productId);
                productTagsCache.set(variant.productId, tags.map(tag => tag.value).join('|'));
            }
            const variantTags = (await this.tagService.getTagsForVariant(ctx, variant.id))
                .map(tag => tag.value)
                .join('|');
            lines.push(
                await this.buildVariantLine(ctx, variant, isFirstOfProduct, {
                    productTags: productTagsCache.get(variant.productId) ?? '',
                    variantTags,
                }, customCols, selectedKeys),
            );
        }
        return lines.join('\n') + '\n';
    }

    /**
     * Update existing variants from a CSV, matched by SKU. Variant-grain only:
     * price/stock/tax/trackInventory/custom-fields. Per-row partial success —
     * no @Transaction wrapper, so good rows commit and bad rows are reported.
     */
    async updateFromCsv(ctx: RequestContext, csv: string): Promise<ImportInfo> {
        const rows = parseCsv(csv);
        const duplicates = detectDuplicateSkus(rows.map(row => row.sku ?? ''));
        const skuMap = await this.loadVariantsBySku(ctx, rows);
        const errors: string[] = [];
        const weightPoolWarned = new Set<ID>();
        let imported = 0;
        for (let i = 0; i < rows.length; i++) {
            const rowNumber = i + 2; // +1 for header, +1 for 1-based
            try {
                const applied = await this.applyUpdateRow(ctx, rows[i], {
                    rowNumber,
                    duplicates,
                    skuMap,
                    weightPoolWarned,
                    errors,
                });
                if (applied) {
                    imported++;
                }
            } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                errors.push(`row ${rowNumber}: ${message}`);
            }
        }
        return { imported, processed: rows.length, errors };
    }

    /**
     * Create new products from a CSV by delegating to core's Importer (the same
     * engine core's importProducts mutation uses) — re-gated to CreateCatalog
     * at the resolver instead of core's SuperAdmin.
     */
    async createFromCsv(ctx: RequestContext, csv: string): Promise<ImportInfo> {
        const progress = await lastValueFrom(this.importer.parseAndImport(csv, ctx, false));
        return {
            imported: progress.imported,
            processed: progress.processed,
            errors: progress.errors ?? [],
        };
    }

    private async applyUpdateRow(
        ctx: RequestContext,
        row: Record<string, string>,
        deps: {
            rowNumber: number;
            duplicates: Set<string>;
            skuMap: Map<string, ProductVariant[]>;
            weightPoolWarned: Set<ID>;
            errors: string[];
        },
    ): Promise<boolean> {
        const sku = (row.sku ?? '').trim();
        if (sku === '') {
            deps.errors.push(`row ${deps.rowNumber}: missing SKU`);
            return false;
        }
        if (deps.duplicates.has(sku)) {
            deps.errors.push(`row ${deps.rowNumber}: duplicate SKU "${sku}" in file`);
            return false;
        }
        const matches = deps.skuMap.get(sku) ?? [];
        if (matches.length === 0) {
            deps.errors.push(`row ${deps.rowNumber}: SKU "${sku}" not found (creation not supported here)`);
            return false;
        }
        if (matches.length > 1) {
            deps.errors.push(`row ${deps.rowNumber}: ambiguous SKU "${sku}" (matches ${matches.length} variants)`);
            return false;
        }
        const variant = matches[0];
        const input = await this.buildVariantUpdateInput(ctx, row, variant, deps);
        await this.productVariantService.update(ctx, [input]);
        return true;
    }

    private async buildVariantUpdateInput(
        ctx: RequestContext,
        row: Record<string, string>,
        variant: ProductVariant,
        deps: { rowNumber: number; weightPoolWarned: Set<ID>; errors: string[] },
    ): Promise<UpdateProductVariantInput> {
        const input: UpdateProductVariantInput = { id: variant.id };
        const price = priceToMinor(row.price ?? '');
        if (price !== null) {
            input.price = price;
        }
        // isCustomFieldTrue, NOT `=== true`: the tinyint arrives as 1, not true.
        const isWeightPool = isCustomFieldTrue(
            (variant.product?.customFields as Record<string, unknown> | undefined)?.productStockEnabled,
        );
        const stock = parseIntCell(row.stockOnHand ?? '');
        if (stock !== null) {
            if (isWeightPool) {
                if (!deps.weightPoolWarned.has(variant.productId)) {
                    deps.weightPoolWarned.add(variant.productId);
                    deps.errors.push(
                        `row ${deps.rowNumber}: stockOnHand skipped for weight-pool product "${variant.product?.name ?? variant.productId}"`,
                    );
                }
            } else {
                input.stockOnHand = stock;
            }
        }
        const taxCategoryName = (row.taxCategory ?? '').trim();
        if (taxCategoryName !== '') {
            input.taxCategoryId = await this.resolveTaxCategoryId(ctx, taxCategoryName);
        }
        const trackInventory = parseTrackInventory(row.trackInventory ?? '');
        if (trackInventory !== null) {
            input.trackInventory = trackInventory as GlobalFlag;
        }
        const customFields: Record<string, number | string> = {};
        const shadowPrice = parseIntCell(row['variant:shadowPrice'] ?? '');
        if (shadowPrice !== null) {
            customFields.shadowPrice = shadowPrice;
        }
        if (Object.keys(customFields).length > 0) {
            input.customFields = customFields;
        }
        return input;
    }

    private async resolveTaxCategoryId(ctx: RequestContext, name: string): Promise<ID> {
        const taxCategory = await this.connection
            .getRepository(ctx, TaxCategory)
            .findOne({ where: { name } });
        if (!taxCategory) {
            throw new Error(`unknown tax category "${name}"`);
        }
        return taxCategory.id;
    }

    private async loadVariantsBySku(
        ctx: RequestContext,
        rows: Array<Record<string, string>>,
    ): Promise<Map<string, ProductVariant[]>> {
        const skus = [...new Set(rows.map(row => (row.sku ?? '').trim()).filter(sku => sku !== ''))];
        const map = new Map<string, ProductVariant[]>();
        if (skus.length === 0) {
            return map;
        }
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.product', 'product')
            .leftJoin('variant.channels', 'channel')
            .where('channel.id = :channelId', { channelId: ctx.channelId })
            .andWhere('variant.sku IN (:...skus)', { skus })
            .andWhere('variant.deletedAt IS NULL')
            .getMany();
        for (const variant of variants) {
            const list = map.get(variant.sku) ?? [];
            list.push(variant);
            map.set(variant.sku, list);
        }
        return map;
    }

    private async buildVariantLine(
        ctx: RequestContext,
        variant: ProductVariant,
        isFirstOfProduct: boolean,
        tags: { productTags: string; variantTags: string },
        customCols: CustomFieldColumn[],
        selectedKeys: string[],
    ): Promise<string> {
        const product = variant.product;
        const productCustomFields = (product?.customFields ?? {}) as Record<string, unknown>;
        const variantCustomFields = (variant.customFields ?? {}) as Record<string, unknown>;
        const isWeightPool = isCustomFieldTrue(productCustomFields.productStockEnabled);
        const stockOnHand = isWeightPool ? '' : String(await this.sumStockOnHand(ctx, variant.id));
        const translation =
            product?.translations?.find(t => t.languageCode === ctx.languageCode) ??
            product?.translations?.[0];
        const variantTranslation =
            variant.translations?.find(t => t.languageCode === ctx.languageCode) ??
            variant.translations?.[0];
        // Base (non-custom-field) columns. Product-level fields only on the first
        // row of each product (grouped layout); variant-level fields on every row.
        const values: Record<string, string> = {
            name: isFirstOfProduct ? translation?.name ?? '' : '',
            'variant:name': variantTranslation?.name ?? '',
            slug: isFirstOfProduct ? translation?.slug ?? '' : '',
            description: isFirstOfProduct ? translation?.description ?? '' : '',
            'product:tags': isFirstOfProduct ? tags.productTags : '',
            sku: variant.sku,
            price: priceToMajor(variant.price ?? 0),
            taxCategory: variant.taxCategory?.name ?? '',
            stockOnHand,
            trackInventory: String(variant.trackInventory ?? '').toLowerCase(),
            'variant:tags': tags.variantTags,
        };
        // Custom-field columns, generated from config. productStockEnabled keeps
        // its legacy 1/0 encoding (it drives weight-pool logic); everything else
        // routes through stringifyCustomField by its declared type.
        for (const column of customCols) {
            const isProductLevel = column.level === 'product';
            if (isProductLevel && !isFirstOfProduct) {
                values[column.key] = '';
                continue;
            }
            if (column.name === 'productStockEnabled') {
                values[column.key] = isWeightPool ? '1' : '0';
                continue;
            }
            const source = isProductLevel ? productCustomFields : variantCustomFields;
            values[column.key] = stringifyCustomField(source[column.name], column.type);
        }
        return buildCsvLine(selectedKeys.map(key => values[key] ?? ''));
    }

    private async sumStockOnHand(ctx: RequestContext, variantId: ID): Promise<number> {
        const levels = await this.connection
            .getRepository(ctx, StockLevel)
            .find({ where: { productVariantId: variantId } });
        return levels.reduce((total, level) => total + level.stockOnHand, 0);
    }
}
