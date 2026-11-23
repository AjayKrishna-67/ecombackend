import {
  Injector,
  ID,
  InternalServerError,
  Logger,
  MultiChannelStockLocationStrategy,
  OrderLine,
  ProductVariant,
  RequestContext,
  StockLevel,
  StockLocation,
  TransactionalConnection,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { isPoolToggleOn } from '../../shared/is-pooled';
import { EMPTY_MEASURE } from '../../shared/measurement';
import { poolExclusionReason, resolvePoolMeasure } from '../../shared/pool-measure';
import { resolveVariantMeasures } from '../../shared/resolve-variant-measure';
import { ProductStockLevel } from '../entities/product-stock-level.entity';

interface AvailableStock {
  stockOnHand: number;
  stockAllocated: number;
}

interface LocationWithQuantity {
  location: StockLocation;
  quantity: number;
}

const loggerCtx = 'ProductStockLocationStrategy';

/**
 * A StockLocationStrategy that supports product-level (weight-based) stock management.
 *
 * When a product has ProductStockLevel records, stock is tracked at the product level
 * in grams. Each variant's availability is calculated as:
 *   floor(remainingProductWeight / variantWeight)
 *
 * The variant-level StockLevel is kept in sync so that:
 *   stockOnHand - stockAllocated = floor(remaining / weight)
 *
 * IMPORTANT: When product-level stock is active, we NEVER fall through to super
 * for allocation/sale/release/cancellation. Falling through causes variant-level
 * stock to be modified independently, breaking the product-level invariant.
 */
export class ProductStockLocationStrategy extends MultiChannelStockLocationStrategy {
  private conn: TransactionalConnection;
  /** Cache variantId → data for 30s to avoid repeated DB lookups in the same request cycle */
  private variantCache = new Map<string, { data: any; expires: number }>();
  private readonly CACHE_TTL = 30_000;

  async init(injector: Injector): Promise<void> {
    await super.init(injector);
    this.conn = injector.get(TransactionalConnection);
  }

  async getAvailableStock(
    ctx: RequestContext,
    productVariantId: ID,
    stockLevels: StockLevel[],
  ): Promise<AvailableStock> {
    const variantData = await this.getVariantData(ctx, productVariantId);
    if (!variantData) {
      return super.getAvailableStock(ctx, productVariantId, stockLevels);
    }
    const { productId, weight } = variantData;
    const totals = await this.conn
      .getRepository(ctx, ProductStockLevel)
      .createQueryBuilder('psl')
      .select('SUM(psl.stockOnHand)', 'totalOnHand')
      .addSelect('SUM(psl.stockAllocated)', 'totalAllocated')
      .where('psl.productId = :productId', { productId })
      .getRawOne();
    if (!totals || totals.totalOnHand === null) {
      return super.getAvailableStock(ctx, productVariantId, stockLevels);
    }
    const totalOnHand = parseInt(totals.totalOnHand, 10) || 0;
    const totalAllocated = parseInt(totals.totalAllocated, 10) || 0;
    const remaining = totalOnHand - totalAllocated;
    const availableUnits = Math.max(0, Math.floor(remaining / weight));
    // Get the actual variant-level stockAllocated so Vendure knows
    // these units are reserved for existing orders (needed for fulfillment)
    const variantAllocated = stockLevels.reduce((sum, sl) => sum + sl.stockAllocated, 0);
    return { stockOnHand: availableUnits + variantAllocated, stockAllocated: variantAllocated };
  }

  async forAllocation(
    ctx: RequestContext,
    stockLocations: StockLocation[],
    orderLine: OrderLine,
    quantity: number,
  ): Promise<LocationWithQuantity[]> {
    const variantId = this.getVariantId(orderLine);
    const variantData = await this.getVariantData(ctx, variantId);
    if (!variantData) {
      return super.forAllocation(ctx, stockLocations, orderLine, quantity);
    }
    const { productId, weight, variantName, productName } = variantData;
    const totalWeightNeeded = quantity * weight;
    const psl = await this.findProductStockLevel(ctx, productId, stockLocations);
    if (!psl) {
      Logger.warn(
        `ProductStockLevel not found for product "${productName}" (${productId}) at given locations. ` +
        `Returning empty allocation.`,
        loggerCtx,
      );
      return [];
    }
    // Re-read with fresh data to avoid race conditions
    const freshPsl = await this.conn.getRepository(ctx, ProductStockLevel).findOne({
      where: { id: psl.id },
    });
    if (!freshPsl) return [];
    const remaining = freshPsl.stockOnHand - freshPsl.stockAllocated;
    if (remaining < totalWeightNeeded) {
      const availKg = (Math.max(0, remaining) / 1000).toFixed(2);
      const needKg = (totalWeightNeeded / 1000).toFixed(2);
      Logger.error(
        `Insufficient stock for "${productName}" — "${variantName}" x${quantity} ` +
        `needs ${needKg} kg but only ${availKg} kg remaining. Blocking allocation.`,
        loggerCtx,
      );
      throw new InternalServerError(
        `Insufficient stock for "${productName}": "${variantName}" x${quantity} needs ${needKg} kg ` +
        `but only ${availKg} kg is available`,
      );
    }
    await this.conn.getRepository(ctx, ProductStockLevel).increment(
      { id: freshPsl.id },
      'stockAllocated',
      totalWeightNeeded,
    );
    const newRemaining = remaining - totalWeightNeeded;
    // Vendure will do: stockAllocated += quantity
    await this.syncVariantStockDisplay(ctx, productId, freshPsl.stockLocationId, newRemaining, {
      variantId,
      vendureOnHandDelta: 0,
      vendureAllocatedDelta: quantity,
    });
    const location = stockLocations.find(sl => String(sl.id) === String(freshPsl.stockLocationId));
    return [{ location: location ?? stockLocations[0], quantity }];
  }

  async forRelease(
    ctx: RequestContext,
    stockLocations: StockLocation[],
    orderLine: OrderLine,
    quantity: number,
  ): Promise<LocationWithQuantity[]> {
    const variantId = this.getVariantId(orderLine);
    const variantData = await this.getVariantData(ctx, variantId);
    if (!variantData) {
      return super.forRelease(ctx, stockLocations, orderLine, quantity);
    }
    const { productId, weight } = variantData;
    const totalWeight = quantity * weight;
    const psl = await this.findProductStockLevel(ctx, productId, stockLocations);
    if (!psl) {
      Logger.warn(
        `ProductStockLevel not found for product ${productId} during release. ` +
        `Returning location for Vendure to handle variant-level release.`,
        loggerCtx,
      );
      return [{ location: stockLocations[0], quantity }];
    }
    const pool = await this.decrementPool(ctx, psl.id, { allocated: totalWeight });
    const newRemaining = pool.stockOnHand - pool.stockAllocated;
    // Vendure will do: stockAllocated -= quantity
    await this.syncVariantStockDisplay(ctx, productId, psl.stockLocationId, newRemaining, {
      variantId,
      vendureOnHandDelta: 0,
      vendureAllocatedDelta: -quantity,
    });
    const location = stockLocations.find(sl => String(sl.id) === String(psl.stockLocationId)) ?? stockLocations[0];
    return [{ location, quantity }];
  }

  async forSale(
    ctx: RequestContext,
    stockLocations: StockLocation[],
    orderLine: OrderLine,
    quantity: number,
  ): Promise<LocationWithQuantity[]> {
    const variantId = this.getVariantId(orderLine);
    const variantData = await this.getVariantData(ctx, variantId);
    if (!variantData) {
      return super.forSale(ctx, stockLocations, orderLine, quantity);
    }
    const { productId, weight } = variantData;
    const totalWeight = quantity * weight;
    const psl = await this.findProductStockLevel(ctx, productId, stockLocations);
    if (!psl) {
      Logger.warn(
        `ProductStockLevel not found for product ${productId} during sale. ` +
        `Returning location for Vendure to handle variant-level sale.`,
        loggerCtx,
      );
      return [{ location: stockLocations[0], quantity }];
    }
    const pool = await this.decrementPool(ctx, psl.id, {
      allocated: totalWeight,
      onHand: totalWeight,
    });
    const newRemaining = pool.stockOnHand - pool.stockAllocated;
    // Vendure will do: stockOnHand -= quantity, stockAllocated -= quantity
    await this.syncVariantStockDisplay(ctx, productId, psl.stockLocationId, newRemaining, {
      variantId,
      vendureOnHandDelta: -quantity,
      vendureAllocatedDelta: -quantity,
    });
    const location = stockLocations.find(sl => String(sl.id) === String(psl.stockLocationId)) ?? stockLocations[0];
    return [{ location, quantity }];
  }

  async forCancellation(
    ctx: RequestContext,
    stockLocations: StockLocation[],
    orderLine: OrderLine,
    quantity: number,
  ): Promise<LocationWithQuantity[]> {
    const variantId = this.getVariantId(orderLine);
    const variantData = await this.getVariantData(ctx, variantId);
    if (!variantData) {
      return super.forCancellation(ctx, stockLocations, orderLine, quantity);
    }
    const { productId, weight } = variantData;
    const totalWeight = quantity * weight;
    const psl = await this.findProductStockLevel(ctx, productId, stockLocations);
    if (!psl) {
      Logger.warn(
        `ProductStockLevel not found for product ${productId} during cancellation. ` +
        `Returning location for Vendure to handle variant-level cancellation.`,
        loggerCtx,
      );
      return [{ location: stockLocations[0], quantity }];
    }
    await this.conn.getRepository(ctx, ProductStockLevel).increment(
      { id: psl.id },
      'stockOnHand',
      totalWeight,
    );
    // Re-read for the same reason the decrements do: the increment itself is
    // atomic, but deriving the mirror from the pre-increment snapshot would
    // publish a figure another concurrent movement has already moved past.
    const afterCancellation = await this.conn
      .getRepository(ctx, ProductStockLevel)
      .findOne({ where: { id: psl.id } });
    const newRemaining = afterCancellation
      ? afterCancellation.stockOnHand - afterCancellation.stockAllocated
      : (psl.stockOnHand + totalWeight) - psl.stockAllocated;
    // Vendure will do: stockOnHand += quantity
    await this.syncVariantStockDisplay(ctx, productId, psl.stockLocationId, newRemaining, {
      variantId,
      vendureOnHandDelta: quantity,
      vendureAllocatedDelta: 0,
    });
    const location = stockLocations.find(sl => String(sl.id) === String(psl.stockLocationId)) ?? stockLocations[0];
    return [{ location, quantity }];
  }

  /**
   * Subtracts from a pool row IN THE DATABASE and returns the resulting
   * stockAllocated.
   *
   * Allocation has always used `increment()`, which compiles to
   * `SET stockAllocated = stockAllocated + :w` — computed by MySQL, so two
   * concurrent allocations cannot overwrite each other. Sale and release did
   * the opposite: read the row into Node, subtract there, write the absolute
   * result back. Under REPEATABLE READ each transaction sees its own snapshot,
   * so two sales settling in the same moment both read X and both write X - w.
   * One decrement vanishes and that weight stays reserved forever.
   *
   * The asymmetry is what made the drift one-way: increments could never be
   * lost, decrements could. Hence 3 pools ended up with more allocated than
   * exists. Doing the arithmetic in SQL closes it — GREATEST keeps the floor at
   * zero that Math.max used to provide.
   */
  private async decrementPool(
    ctx: RequestContext,
    poolId: ID,
    amounts: { allocated: number; onHand?: number },
  ): Promise<AvailableStock> {
    const repo = this.conn.getRepository(ctx, ProductStockLevel);
    const update = repo
      .createQueryBuilder()
      .update(ProductStockLevel)
      .set({
        stockAllocated: () => 'GREATEST(0, stockAllocated - :allocatedDelta)',
        ...(amounts.onHand != null
          ? { stockOnHand: () => 'GREATEST(0, stockOnHand - :onHandDelta)' }
          : {}),
      })
      .where('id = :poolId', { poolId })
      .setParameters({
        allocatedDelta: amounts.allocated,
        ...(amounts.onHand != null ? { onHandDelta: amounts.onHand } : {}),
      });
    await update.execute();
    // Read back rather than computing the expected value: another transaction
    // may legitimately have moved the row between the update and here, and the
    // variant mirror must be derived from what the pool actually holds.
    const fresh = await repo.findOne({ where: { id: poolId } });
    return {
      stockOnHand: fresh?.stockOnHand ?? 0,
      stockAllocated: fresh?.stockAllocated ?? 0,
    };
  }

  /**
   * Safely gets the productVariantId from an OrderLine.
   */
  private getVariantId(orderLine: OrderLine): ID {
    return (orderLine as any).productVariantId ?? orderLine.productVariant?.id;
  }

  /**
   * Syncs variant StockLevel.stockOnHand so that:
   *   stockOnHand - stockAllocated = calculatedAvailable
   *
   * We NEVER touch stockAllocated — Vendure manages it naturally.
   * We pre-compensate for Vendure's pending changes to the operated variant.
   *
   * Formula:
   *   finalAllocated = currentAllocated + vendureAllocatedDelta
   *   desiredOnHand  = calculatedAvailable + finalAllocated
   *   sl.stockOnHand = desiredOnHand - vendureOnHandDelta
   *
   * After Vendure applies its deltas:
   *   stockOnHand = desiredOnHand, stockAllocated = finalAllocated
   *   available   = desiredOnHand - finalAllocated = calculatedAvailable ✓
   */
  private async syncVariantStockDisplay(
    ctx: RequestContext,
    productId: ID,
    stockLocationId: ID,
    remainingWeight: number,
    compensate?: {
      variantId: ID;
      vendureOnHandDelta: number;
      vendureAllocatedDelta: number;
    },
  ): Promise<void> {
    const variants = await this.conn.getRepository(ctx, ProductVariant).find({
      where: { productId, deletedAt: IsNull() },
    });
    if (variants.length === 0) return;
    // Batch-fetch all stock levels for these variants at this location in one query
    const slRepo = this.conn.getRepository(ctx, StockLevel);
    const variantIds = variants.map(v => v.id);
    const stockLevels = await slRepo
      .createQueryBuilder('sl')
      .where('sl.productVariantId IN (:...variantIds)', { variantIds })
      .andWhere('sl.stockLocationId = :stockLocationId', { stockLocationId })
      .getMany();
    const slMap = new Map(stockLevels.map(sl => [String(sl.productVariantId), sl]));
    // Each variant's measurement, read off its option. Batched
    // so this stays one query no matter how many variants the product has.
    const measures = await resolveVariantMeasures(ctx, this.conn, variants);
    // Compute updated stockOnHand for each variant
    const toSave: StockLevel[] = [];
    const toInsert: { productVariantId: any; stockLocationId: any; stockOnHand: number; stockAllocated: number }[] = [];
    // The pool's base unit comes from the attached option group; a variant
    // authored in a different base cannot draw from it and is skipped here the
    // same way a weightless variant always was.
    const pool = resolvePoolMeasure(measures);
    for (const variant of variants) {
      const weight = pool?.drawByVariantId.get(String(variant.id));
      if (!weight || weight <= 0) continue;
      const calculated = Math.max(0, Math.floor(remainingWeight / weight));
      const sl = slMap.get(String(variant.id));
      let vendureOnHandDelta = 0;
      let vendureAllocatedDelta = 0;
      if (compensate && String(variant.id) === String(compensate.variantId)) {
        vendureOnHandDelta = compensate.vendureOnHandDelta;
        vendureAllocatedDelta = compensate.vendureAllocatedDelta;
      }
      if (sl) {
        const finalAllocated = sl.stockAllocated + vendureAllocatedDelta;
        const desiredOnHand = calculated + finalAllocated;
        sl.stockOnHand = desiredOnHand - vendureOnHandDelta;
        toSave.push(sl);
      } else {
        // Create missing stock_level record for this variant
        const initialAllocated = Math.max(0, vendureAllocatedDelta);
        toInsert.push({
          productVariantId: variant.id,
          stockLocationId,
          stockOnHand: calculated + initialAllocated - vendureOnHandDelta,
          stockAllocated: 0, // Vendure will apply its delta after this
        });
      }
    }
    // Batch-save existing levels
    if (toSave.length > 0) {
      await slRepo.save(toSave);
    }
    // Batch-insert missing levels
    if (toInsert.length > 0) {
      await slRepo
        .createQueryBuilder()
        .insert()
        .into(StockLevel)
        .values(toInsert)
        .execute();
    }
  }

  private async getVariantData(
    ctx: RequestContext,
    variantId: ID,
  ): Promise<{ productId: ID; weight: number; variantName: string; productName: string } | undefined> {
    const cacheKey = String(variantId);
    const cached = this.variantCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.data;
    }
    const variant = await this.conn.getRepository(ctx, ProductVariant).findOne({
      where: { id: variantId },
      relations: ['translations', 'product', 'product.translations'],
    });
    if (!variant) {
      Logger.warn(`[product-pool] variant ${variantId} not found — falling back to per-variant stock`, loggerCtx);
      this.variantCache.set(cacheKey, { data: undefined, expires: Date.now() + this.CACHE_TTL });
      return undefined;
    }
    // NOTE: the result lands in `variantCache` for CACHE_TTL (30 s), so an edit
    // to an option's measureValue takes up to 30 s to show up here, for every
    // product using that option group.
    // Resolved across the WHOLE product, not just this variant, because the
    // pool's base unit is a property of the product's option group rather than
    // of any one variant. Asking this variant alone would let a piece-authored
    // variant draw from a gram pool on a product that mixes both.
    const siblings = await this.conn.getRepository(ctx, ProductVariant).find({
      where: { productId: variant.productId, deletedAt: IsNull() },
    });
    const measures = await resolveVariantMeasures(ctx, this.conn, siblings);
    const pool = resolvePoolMeasure(measures);
    const measure = measures.get(String(variantId)) ?? EMPTY_MEASURE;
    const weight = pool?.drawByVariantId.get(String(variantId));
    if (!weight || weight <= 0) {
      // Every bail here silently downgrades the product to per-variant Vendure
      // stock: the order still allocates, but ProductStockLevel.stockAllocated
      // never moves, so the pool looks untouched. That is invisible without a
      // log line, which is why this is a warn and not a debug.
      const reason = poolExclusionReason(pool, String(variantId), measure);
      Logger.warn(
        `[product-pool] variant ${variantId} cannot draw from the pool — ${reason} ` +
        `(source=${measure.source}, unit=${measure.unit}, baseValue=${measure.baseValue}). ` +
        `Falling back to per-variant stock. Set a Measure Value and Measure Unit on its option.`,
        loggerCtx,
      );
      this.variantCache.set(cacheKey, { data: undefined, expires: Date.now() + this.CACHE_TTL });
      return undefined;
    }
    // Product-level stock is active only when the merchant flips on the
    // `productStockEnabled` toggle for this product. When off, fall through to
    // standard per-variant Vendure stock.
    // isPoolToggleOn, NOT `=== true`: MySQL returns this tinyint as the number
    // 1, and `1 === true` is false. The pool row is checked separately by
    // findProductStockLevel, which together make up shared/is-pooled.ts — the
    // one definition the cart and checkout validators share.
    const productStockEnabled = isPoolToggleOn(variant.product?.customFields);
    if (!productStockEnabled) {
      Logger.warn(
        `[product-pool] product ${variant.productId} has productStockEnabled off — ` +
        `variant ${variantId} falling back to per-variant stock`,
        loggerCtx,
      );
      this.variantCache.set(cacheKey, { data: undefined, expires: Date.now() + this.CACHE_TTL });
      return undefined;
    }
    Logger.debug(
      `[product-pool] variant ${variantId} draws ${weight} ${pool!.baseUnit} from ${measure.source}`,
      loggerCtx,
    );
    const langCode = ctx.languageCode;
    const variantName = variant.translations.find(t => t.languageCode === langCode)?.name
      ?? variant.translations[0]?.name ?? variant.sku;
    const productName = variant.product?.translations?.find(t => t.languageCode === langCode)?.name
      ?? variant.product?.translations?.[0]?.name ?? `Product #${variant.productId}`;
    const data = { productId: variant.productId, weight, variantName, productName };
    this.variantCache.set(cacheKey, { data, expires: Date.now() + this.CACHE_TTL });
    // Evict old entries periodically
    if (this.variantCache.size > 500) {
      const now = Date.now();
      for (const [key, val] of this.variantCache) {
        if (val.expires < now) this.variantCache.delete(key);
      }
    }
    return data;
  }

  private async findProductStockLevel(
    ctx: RequestContext,
    productId: ID,
    stockLocations: StockLocation[],
  ): Promise<ProductStockLevel | null> {
    if (stockLocations.length === 0) return null;
    const locationIds = stockLocations.map(sl => sl.id);
    // Single query to find the first matching product stock level across all locations
    return this.conn.getRepository(ctx, ProductStockLevel)
      .createQueryBuilder('psl')
      .where('psl.productId = :productId', { productId })
      .andWhere('psl.stockLocationId IN (:...locationIds)', { locationIds })
      .getOne() ?? null;
  }
}
