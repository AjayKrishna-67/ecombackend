import { Injectable } from '@nestjs/common';
import {
    TransactionalConnection,
    Order,
    OrderLine,
    RequestContext,
    Logger,
    ID,
    ProductVariant,
} from '@vendure/core';
import {
    CartValidationStatus,
    UnavailableCartItem,
    UnavailabilityReason,
} from '../types/validation-types';
import { isPooled } from '../../../Stock/shared/is-pooled';
import { EMPTY_MEASURE, VariantMeasure } from '../../../Stock/shared/measurement';
import {
    displayUnitForBase,
    poolUnitLabel,
    resolvePoolMeasure,
} from '../../../Stock/shared/pool-measure';
import { fromBase } from '../../../Stock/shared/stock-units';
import { resolveVariantMeasures } from '../../../Stock/shared/resolve-variant-measure';
import { ProductStockLevel } from '../../../Stock/product-stock/entities/product-stock-level.entity';
import { minimumOrderOf, minimumOrderStatus } from './minimum-order';

const loggerCtx = 'CartValidationService';

/**
 * Service for validating cart items availability
 */
@Injectable()
export class CartValidationService {
    private validationCache = new WeakMap<Order, CartValidationStatus>();
    
    constructor(private connection: TransactionalConnection) {}
    
    /**
     * Validate all items in an order
     */
    async validateOrder(ctx: RequestContext, order: Order): Promise<CartValidationStatus> {
        // Check cache first
        if (this.validationCache.has(order)) {
            Logger.debug(
                `Using cached validation for order ${order.code}`,
                loggerCtx
            );
            return this.validationCache.get(order)!;
        }
        
        // `order.lines` is only populated when the caller's own GraphQL
        // selection asked for it: Vendure's `@Relations` decorator on
        // activeOrder/addItemToOrder/etc joins relations based on the
        // incoming query shape, and has no way to know this bolted-on
        // `validationStatus` field needs them too. A client selecting only
        // `validationStatus` (no `lines`) leaves `order.lines` `undefined`
        // entirely -- fetch it ourselves so this never depends on what else
        // the client happened to select.
        const lines = order.lines ?? await this.connection
            .getRepository(ctx, OrderLine)
            .find({ where: { order: { id: order.id } } });

        Logger.debug(
            `Validating order ${order.code} with ${lines.length} items`,
            loggerCtx
        );

        if (lines.length === 0) {
            const emptyResult: CartValidationStatus = {
                isValid: true,
                hasUnavailableItems: false,
                totalUnavailableItems: 0,
                unavailableItems: [],
                ...this.minimumOrder(ctx, order),
            };
            this.validationCache.set(order, emptyResult);
            return emptyResult;
        }

        // `productVariantId` is a plain FK column, always present on the row
        // regardless of relation-loading -- unlike `line.productVariant`,
        // which comes back `undefined` both when the relation wasn't joined
        // AND when the variant it points to has since been deleted. Building
        // the id list from the column sidesteps both cases at once.
        const variantIds = [...new Set(lines.map(l => l.productVariantId))];

        // Bulk load all variants with their products. `deletedAt` is a plain
        // column here, not TypeORM's `@DeleteDateColumn` -- nothing filters
        // a soft-deleted variant out automatically, so a query that omits
        // this would find it and report it as available. Every other variant
        // query in this file (and in Vendure core's own addItemsToOrder)
        // filters it explicitly for the same reason.
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.product', 'product')
            .leftJoinAndSelect('variant.translations', 'variantTranslations')
            .leftJoinAndSelect('product.translations', 'productTranslations')
            .where('variant.id IN (:...variantIds)', { variantIds })
            .andWhere('variant.deletedAt IS NULL')
            .getMany();

        // Build availability map
        const availabilityMap = new Map<
            ID,
            { isAvailable: boolean; reason: string | null; product: any; variant: any; productName: string; variantName: string }
        >();

        for (const variant of variants) {
            const productEnabled = variant.product?.enabled ?? false;
            const variantEnabled = variant.enabled;
            const isAvailable = productEnabled && variantEnabled;
            const reason = isAvailable
                ? null
                : this.determineUnavailabilityReason(productEnabled, variantEnabled);

            // Get translated names
            const productName = this.getTranslatedName(variant.product, ctx.languageCode);
            const variantName = this.getTranslatedName(variant, ctx.languageCode);

            // Debug: Log product data
            Logger.debug(
                `Variant ${variant.id}: Product="${productName}", Variant="${variantName}", Enabled=${isAvailable}`,
                loggerCtx
            );

            availabilityMap.set(variant.id, {
                isAvailable,
                reason,
                product: variant.product,
                variant: variant,
                productName,
                variantName,
            });
        }

        // Check each order line and collect unavailable items. A line whose
        // variant id has no match in `availabilityMap` means the bulk fetch
        // above found no such ProductVariant row at all -- it's been deleted
        // since this line was added to the cart.
        const unavailableItems: UnavailableCartItem[] = [];

        for (const line of lines) {
            const availability = availabilityMap.get(line.productVariantId);

            if (!availability) {
                unavailableItems.push({
                    orderLineId: line.id,
                    productName: 'Unknown',
                    variantName: 'Unknown',
                    reason: UnavailabilityReason.PRODUCT_REMOVED,
                });
            } else if (!availability.isAvailable) {
                unavailableItems.push({
                    orderLineId: line.id,
                    productName: availability.productName,
                    variantName: availability.variantName,
                    reason: availability.reason || 'Product is not available',
                });
            }
        }

        // Product-level stock validation (shared weight pool)
        const stockMessages = await this.validateProductLevelStock(ctx, lines, variants, unavailableItems);

        // Build validation result
        const validationResult: CartValidationStatus = {
            isValid: unavailableItems.length === 0,
            hasUnavailableItems: unavailableItems.length > 0,
            totalUnavailableItems: unavailableItems.length,
            unavailableItems,
            message: stockMessages.length > 0 ? stockMessages.join('; ') : null,
            ...this.minimumOrder(ctx, order),
        };
        
        // Cache result
        this.validationCache.set(order, validationResult);
        
        if (!validationResult.isValid) {
            Logger.info(
                `Order ${order.code} validation failed: ${validationResult.totalUnavailableItems} unavailable items`,
                loggerCtx
            );
        }
        
        return validationResult;
    }
    
    /**
     * The order's product total (after discounts, before delivery charges)
     * against the minimum order value of the channel it is placed in.
     * `isValid` keeps meaning "every item is available"; the minimum is
     * reported in its own fields.
     */
    minimumOrder(ctx: RequestContext, order: Order) {
        return minimumOrderStatus(order.subTotalWithTax ?? 0, minimumOrderOf(ctx.channel));
    }

    /**
     * Bulk-loads the variants `lineAvailability` needs (product + stock levels
     * with their locations' channels), one query for any number of lines.
     * Called through AvailabilityVariantDataLoader, which batches the per-line
     * field resolvers into a single call.
     */
    async findVariantsForAvailability(ctx: RequestContext, variantIds: ID[]): Promise<ProductVariant[]> {
        if (variantIds.length === 0) return [];
        return this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.product', 'product')
            .leftJoinAndSelect('variant.stockLevels', 'stockLevel')
            .leftJoinAndSelect('stockLevel.stockLocation', 'stockLocation')
            .leftJoinAndSelect('stockLocation.channels', 'slChannel')
            .where('variant.id IN (:...variantIds)', { variantIds })
            .andWhere('variant.deletedAt IS NULL')
            .getMany();
    }

    /**
     * Whether a specific order line is available (enabled + in stock).
     *
     * `variant` is the line's variant as loaded by `findVariantsForAvailability`
     * -- looked up by the `productVariantId` FK column, which is always present
     * regardless of whether the `productVariant` relation was joined. `undefined`
     * means no live variant row exists: it has been deleted since the line was
     * added to the cart.
     */
    lineAvailability(
        ctx: RequestContext,
        orderLine: OrderLine,
        variant: ProductVariant | undefined,
    ): { isAvailable: boolean; reason: string | null } {
        if (!variant) {
            return { isAvailable: false, reason: UnavailabilityReason.PRODUCT_REMOVED };
        }

        const productEnabled = variant.product?.enabled ?? false;
        const variantEnabled = variant.enabled;

        if (!productEnabled || !variantEnabled) {
            return {
                isAvailable: false,
                reason: this.determineUnavailabilityReason(productEnabled, variantEnabled),
            };
        }

        if (variant.trackInventory === 'FALSE' ||
            (variant.trackInventory === 'INHERIT' && !(variant as any).globalTrackInventory)) {
            return { isAvailable: true, reason: null };
        }

        const channelId = ctx.channelId;
        const channelStockLevels = (variant.stockLevels || []).filter(sl =>
            sl.stockLocation?.channels?.some((c: any) => c.id === channelId)
        );
        const totalStockOnHand = channelStockLevels
            .reduce((sum, sl) => sum + (sl.stockOnHand || 0), 0);
        const totalStockAllocated = channelStockLevels
            .reduce((sum, sl) => sum + (sl.stockAllocated || 0), 0);
        const saleableStock = totalStockOnHand - totalStockAllocated;

        if (saleableStock <= 0) {
            return { isAvailable: false, reason: 'This item is currently out of stock' };
        }

        if (saleableStock < orderLine.quantity) {
            return {
                isAvailable: false,
                reason: `Only ${saleableStock} available, kindly decrease quantity`,
            };
        }

        return { isAvailable: true, reason: null };
    }
    
    /**
     * Validates product-level (weight-based) stock for all order lines.
     * Groups lines by product, sums total weight needed, and checks
     * against the shared product stock pool. Marks ALL exceeding lines
     * as unavailable in a single pass.
     */
    private async validateProductLevelStock(
        ctx: RequestContext,
        lines: OrderLine[],
        variants: ProductVariant[],
        unavailableItems: UnavailableCartItem[],
    ): Promise<string[]> {
        const overallMessages: string[] = [];
        // Already-flagged line IDs (from enabled/disabled/removed checks)
        const flaggedLineIds = new Set(unavailableItems.map(i => String(i.orderLineId)));
        const variantMap = new Map(variants.map(v => [String(v.id), v]));

        // Group by PRODUCT before doing anything with measurements. The pool's
        // unit is a property of the product's option group, so it cannot be
        // decided one line at a time.
        const linesByProduct = new Map<string, OrderLine[]>();
        for (const line of lines) {
            if (flaggedLineIds.has(String(line.id))) continue;
            const variant = variantMap.get(String(line.productVariantId));
            if (!variant) continue;
            const productId = String(variant.productId);
            const bucket = linesByProduct.get(productId);
            if (bucket) {
                bucket.push(line);
            } else {
                linesByProduct.set(productId, [line]);
            }
        }
        if (linesByProduct.size === 0) return overallMessages;

        // Single batch query: which of these products use product-level stock?
        const candidateIds = [...linesByProduct.keys()];
        const productStockRows = await this.connection
            .getRepository(ctx, ProductStockLevel)
            .createQueryBuilder('psl')
            .select('DISTINCT psl.productId', 'productId')
            .where('psl.productId IN (:...candidateIds)', { candidateIds })
            .getRawMany();
        const productStockSet = new Set(productStockRows.map((r: any) => String(r.productId)));
        // A pool row alone does NOT mean the pool governs this product: the
        // `productStockEnabled` toggle does, and the row is kept behind it so a
        // merchant can flip back without re-entering stock. Asking only about
        // the row is what let a toggled-off product be added to a cart (the
        // strategy had moved to per-variant stock) and then blocked at checkout
        // by a pool reading 0. Both questions, one answer: shared/is-pooled.ts.
        const pooledProductIds = candidateIds.filter(productId => {
            const customFields = linesByProduct.get(productId)
                ?.map(line => variantMap.get(String(line.productVariantId))?.product?.customFields)
                .find(fields => fields != null);
            return isPooled(customFields, productStockSet.has(productId));
        });
        if (pooledProductIds.length === 0) return overallMessages;

        // Resolve measurements from each product's FULL variant set, not only the
        // variants this cart happens to contain. The pool's base unit is decided
        // across all of them, and a cart holding one variant must not be able to
        // reach a different conclusion than the admin overview does.
        const pooledVariants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .where('variant.productId IN (:...pooledProductIds)', { pooledProductIds })
            .andWhere('variant.deletedAt IS NULL')
            .getMany();
        const allMeasures = await resolveVariantMeasures(ctx, this.connection, pooledVariants);

        for (const productId of pooledProductIds) {
            const own = new Map<string, VariantMeasure>();
            for (const variant of pooledVariants) {
                if (String(variant.productId) === productId) {
                    own.set(String(variant.id), allMeasures.get(String(variant.id)) ?? EMPTY_MEASURE);
                }
            }
            // Reads `baseValue`, not `grams`. Reading grams is what let this
            // check pass a cart that drew 50 pieces from a 20-piece pool: a
            // counted variant has no weight by design, so every one of its lines
            // was skipped and the product never even became a candidate.
            const pool = resolvePoolMeasure(own);
            if (!pool) continue;

            const productLines = linesByProduct.get(productId) ?? [];
            const drawn: Array<{ line: OrderLine; variantName: string }> = [];
            let totalNeeded = 0;
            for (const line of productLines) {
                const draw = pool.drawByVariantId.get(String(line.productVariantId));
                if (!draw || draw <= 0) continue;
                totalNeeded += line.quantity * draw;
                const variant = variantMap.get(String(line.productVariantId));
                drawn.push({
                    line,
                    variantName: variant
                        ? this.getTranslatedName(variant, ctx.languageCode as string)
                        : String(line.productVariantId),
                });
            }
            if (totalNeeded === 0 || drawn.length === 0) continue;

            const totals = await this.connection
                .getRepository(ctx, ProductStockLevel)
                .createQueryBuilder('psl')
                .select('SUM(psl.stockOnHand)', 'totalOnHand')
                .addSelect('SUM(psl.stockAllocated)', 'totalAllocated')
                .where('psl.productId = :productId', { productId })
                .getRawOne();
            if (!totals || totals.totalOnHand === null) continue;
            const totalOnHand = parseInt(totals.totalOnHand, 10) || 0;
            const totalAllocated = parseInt(totals.totalAllocated, 10) || 0;
            const remaining = totalOnHand - totalAllocated;
            if (remaining >= totalNeeded) continue;

            // Reported in the pool's own unit. The message used to be hardcoded
            // to kg, which on a piece pool would have told a shopper they had
            // ordered "0.05 kg" of lemons.
            const displayUnit = displayUnitForBase(pool.baseUnit);
            const label = poolUnitLabel(pool.baseUnit);
            const have = fromBase(Math.max(0, remaining), displayUnit);
            const need = fromBase(totalNeeded, displayUnit);
            const firstVariant = variantMap.get(String(drawn[0].line.productVariantId));
            const productName = firstVariant
                ? this.getTranslatedName(firstVariant.product, ctx.languageCode as string)
                : `Product ${productId}`;
            const itemsSummary = drawn.map(d => `${d.variantName} x${d.line.quantity}`).join(', ');
            Logger.warn(
                `Product-level stock insufficient for "${productName}" (${productId}): ` +
                `need ${need} ${label}, have ${have} ${label}. Items: ${itemsSummary}`,
                loggerCtx,
            );
            overallMessages.push(
                `Insufficient stock for "${productName}": you added ${need} ${label} but only ${have} ${label} is available`,
            );
            for (const { line, variantName } of drawn) {
                unavailableItems.push({
                    orderLineId: line.id,
                    productName,
                    variantName,
                    reason: '',
                });
            }
        }
        return overallMessages;
    }

    /**
     * Determine the reason why an item is unavailable
     */
    private determineUnavailabilityReason(
        productEnabled: boolean,
        variantEnabled: boolean
    ): string {
        if (!productEnabled && !variantEnabled) {
            return UnavailabilityReason.BOTH_DISABLED;
        } else if (!productEnabled) {
            return UnavailabilityReason.PRODUCT_DISABLED;
        } else {
            return UnavailabilityReason.VARIANT_DISABLED;
        }
    }
    
    /**
     * Get translated name from entity
     */
    private getTranslatedName(entity: any, languageCode: string): string {
        if (!entity) {
            return 'Unknown';
        }
        
        // First try: direct name property (already translated by Vendure)
        if (entity.name) {
            return entity.name;
        }
        
        // Second try: find translation for the current language
        if (entity.translations && entity.translations.length > 0) {
            const translation = entity.translations.find(
                (t: any) => t.languageCode === languageCode
            );
            if (translation?.name) {
                return translation.name;
            }
            
            // Fallback: use first available translation
            if (entity.translations[0]?.name) {
                return entity.translations[0].name;
            }
        }
        
        return 'Unknown';
    }
}
