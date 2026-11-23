import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  Allow,
  Ctx,
  ID,
  Permission,
  ProductVariant,
  RequestContext,
  StockLevel,
  Transaction,
  TransactionalConnection,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { EMPTY_MEASURE, VariantMeasure } from '../../../../shared/measurement';
import { resolvePoolMeasure } from '../../../../shared/pool-measure';
import { resolveVariantMeasures } from '../../../../shared/resolve-variant-measure';
import { formatMeasured } from '../../../../shared/stock-units';
import { ProductStockService } from '../../../services/product-stock.service';
import { ProductStockLevel } from '../../../entities/product-stock-level.entity';

/** One variant the pool cannot include, shaped for the admin warning. */
interface ExcludedVariantInfo {
  variantId: ID;
  sku: string;
  name: string;
  measure: string | null;
  source: string;
  reason: string;
}

/**
 * Human-readable magnitude for a resolved measure, e.g. '250 g', '1.5 litre'.
 *
 * Null rather than a placeholder when nothing resolved: the warning says
 * "no measurement" in words, and a fake '0 g' here would read as a real value.
 */
function describeMeasure(measure: VariantMeasure): string | null {
  return measure.baseValue == null ? null : formatMeasured(measure.baseValue, measure.baseUnit);
}

@Resolver()
export class AdminProductStockResolver {
  constructor(
    private readonly productStockService: ProductStockService,
    private readonly connection: TransactionalConnection,
  ) {}

  @Query()
  @Allow(Permission.ReadCatalog)
  async productStockLevels(
    @Ctx() ctx: RequestContext,
    @Args('productId') productId: ID,
  ): Promise<ProductStockLevel[]> {
    return this.productStockService.getProductStockLevels(ctx, productId);
  }

  @Query()
  @Allow(Permission.ReadCatalog)
  async productStockOverview(
    @Ctx() ctx: RequestContext,
    @Args('productId') productId: ID,
  ): Promise<{
    productId: ID;
    stockOnHand: number;
    stockAllocated: number;
    availableWeight: number;
    baseUnit: string;
    variants: Array<{
      variantId: ID;
      sku: string;
      name: string;
      weight: number;
      availableStock: number;
      stockOnHand: number;
      stockAllocated: number;
    }>;
    excludedVariants: ExcludedVariantInfo[];
  }> {
    const levels = await this.productStockService.getProductStockLevels(ctx, productId);
    const totalOnHand = levels.reduce((sum, l) => sum + l.stockOnHand, 0);
    const totalAllocated = levels.reduce((sum, l) => sum + l.stockAllocated, 0);
    const availableWeight = totalOnHand - totalAllocated;

    // IsNull(), not `deletedAt: undefined` -- TypeORM strips an undefined
    // property, so the old form filtered nothing and soft-deleted variants rode
    // into the overview. Harmless while they only failed to resolve a measure;
    // not harmless now that an unmeasured variant raises a warning below.
    const variants = await this.connection.getRepository(ctx, ProductVariant).find({
      where: { productId, deletedAt: IsNull() },
      relations: ['translations'],
    });

    const measures = await resolveVariantMeasures(ctx, this.connection, variants);
    // What the pool integer counts, decided by the attached option group:
    // grams for a kg group, pieces for a Nos group. Null when no variant
    // carries a magnitude — the block then has a unit to label itself with but
    // no variants to divide, which is exactly what an unmeasured product is.
    const pool = resolvePoolMeasure(measures);
    const pooledVariants = pool
      ? variants.filter(v => pool.drawByVariantId.has(String(v.id)))
      : [];
    // Fetch per-variant StockLevel allocated counts
    const variantIds = pooledVariants.map(v => v.id);
    let stockLevelMap = new Map<string, { stockOnHand: number; stockAllocated: number }>();
    if (variantIds.length > 0) {
      const stockLevels = await this.connection.getRepository(ctx, StockLevel)
        .createQueryBuilder('sl')
        .select('sl.productVariantId', 'variantId')
        .addSelect('SUM(sl.stockOnHand)', 'totalOnHand')
        .addSelect('SUM(sl.stockAllocated)', 'totalAllocated')
        .where('sl.productVariantId IN (:...variantIds)', { variantIds })
        .groupBy('sl.productVariantId')
        .getRawMany();
      for (const row of stockLevels) {
        stockLevelMap.set(String(row.variantId), {
          stockOnHand: parseInt(row.totalOnHand, 10) || 0,
          stockAllocated: parseInt(row.totalAllocated, 10) || 0,
        });
      }
    }

    const langCode = ctx.languageCode;
    const variantInfos = pooledVariants.map(v => {
      // Non-null: pooledVariants was filtered on the same map above.
      const weight = pool!.drawByVariantId.get(String(v.id))!;
      const translation = v.translations.find(t => t.languageCode === langCode)
        ?? v.translations[0];
      const slData = stockLevelMap.get(String(v.id));
      return {
        variantId: v.id,
        sku: v.sku,
        name: translation?.name ?? v.sku,
        weight,
        availableStock: Math.max(0, Math.floor(availableWeight / weight)),
        stockOnHand: slData?.stockOnHand ?? 0,
        stockAllocated: slData?.stockAllocated ?? 0,
      };
    });

    // Everything the pool left behind. `resolvePoolMeasure` already works this
    // out for its own arithmetic but threw it away; a variant that silently
    // disappears from this table reads as lost stock, when it is really an
    // option authored in a unit the pool cannot add up.
    const excludedVariants = variants
      .filter(v => !pool?.drawByVariantId.has(String(v.id)))
      .map(v => {
        const measure = measures.get(String(v.id)) ?? EMPTY_MEASURE;
        const translation = v.translations.find(t => t.languageCode === langCode)
          ?? v.translations[0];
        return {
          variantId: v.id,
          sku: v.sku,
          name: translation?.name ?? v.sku,
          measure: describeMeasure(measure),
          source: measure.source,
          reason: measure.baseValue != null ? 'UNIT_MISMATCH' : 'NO_MEASUREMENT',
        };
      });

    return {
      productId,
      stockOnHand: totalOnHand,
      stockAllocated: totalAllocated,
      availableWeight,
      // Defaults to grams so a product with nothing measured still labels its
      // (empty) pool the way every existing product does, rather than flipping
      // the whole block to pieces the moment the options are blank.
      baseUnit: pool?.baseUnit ?? 'g',
      variants: variantInfos,
      excludedVariants,
    };
  }

  @Mutation()
  @Transaction()
  @Allow(Permission.UpdateCatalog)
  async setProductStock(
    @Ctx() ctx: RequestContext,
    @Args('input') input: { productId: ID; stockLocationId: ID; stockOnHand: number },
  ): Promise<ProductStockLevel> {
    return this.productStockService.setProductStock(
      ctx,
      input.productId,
      input.stockLocationId,
      input.stockOnHand,
    );
  }

  @Mutation()
  @Transaction()
  @Allow(Permission.UpdateCatalog)
  async removeProductStock(
    @Ctx() ctx: RequestContext,
    @Args('productId') productId: ID,
  ): Promise<boolean> {
    const repo = this.connection.getRepository(ctx, ProductStockLevel);
    const result = await repo.delete({ productId });
    return (result.affected ?? 0) > 0;
  }

  @Mutation()
  @Transaction()
  @Allow(Permission.UpdateCatalog)
  async resyncProductStock(
    @Ctx() ctx: RequestContext,
    @Args('productId') productId: ID,
  ): Promise<boolean> {
    const levels = await this.productStockService.getProductStockLevels(ctx, productId);
    if (levels.length === 0) return false;
    // Rebuild the reservation total BEFORE deriving the variant mirror from it.
    // Re-syncing alone only copied the pool's drift down onto the variants —
    // which is why staff pressed this button 63 times in a week and the product
    // stayed sold out. reconcileAllocated re-derives the mirror itself.
    const result = await this.productStockService.reconcileAllocated(ctx, productId);
    if (result.status === 'reconciled') return true;
    for (const psl of levels) {
      await this.productStockService.ensureVariantStockLevels(ctx, productId, psl.stockLocationId);
    }
    return true;
  }
}
