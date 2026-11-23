import { Injectable } from '@nestjs/common';
import {
  FulfillmentLine,
  ID,
  Logger,
  OrderLine,
  Product,
  ProductVariant,
  RequestContext,
  StockLevel,
  StockLocation,
  TransactionalConnection,
  UserInputError,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { resolvePoolMeasure } from '../../shared/pool-measure';
import { resolveVariantMeasures } from '../../shared/resolve-variant-measure';
import { ProductStockLevel } from '../entities/product-stock-level.entity';

const loggerCtx = 'ProductStockService';

/**
 * Order states holding no stock reservation.
 *
 * `Cancelled` released it, and the four pre-placement states never took any —
 * they are listed as well as the `orderPlacedAt IS NOT NULL` test because this
 * catalogue also carries hand-written states ('Payment authorized' with a
 * space, 'ProductDeliveredNotificationProcess') whose placement timestamps are
 * not guaranteed. Anything not named here, including every delivery state, is
 * treated as holding its unfulfilled units.
 */
const RELEASED_ORDER_STATES = ['Cancelled', 'Draft', 'Created', 'AddingItems', 'ArrangingPayment'] as const;

@Injectable()
export class ProductStockService {
  constructor(private readonly connection: TransactionalConnection) {}

  async getProductStockLevels(ctx: RequestContext, productId: ID): Promise<ProductStockLevel[]> {
    return this.connection.getRepository(ctx, ProductStockLevel).find({
      where: { productId },
      relations: ['stockLocation'],
    });
  }

  async setProductStock(
    ctx: RequestContext,
    productId: ID,
    stockLocationId: ID,
    stockOnHand: number,
  ): Promise<ProductStockLevel> {
    const product = await this.connection.getRepository(ctx, Product).findOne({
      where: { id: productId },
    });
    if (!product) {
      throw new UserInputError(`Product with id "${productId}" not found`);
    }
    const stockLocation = await this.connection.getRepository(ctx, StockLocation).findOne({
      where: { id: stockLocationId },
    });
    if (!stockLocation) {
      throw new UserInputError(`StockLocation with id "${stockLocationId}" not found`);
    }

    let productStockLevel = await this.connection
      .getRepository(ctx, ProductStockLevel)
      .findOne({ where: { productId, stockLocationId } });

    if (productStockLevel) {
      productStockLevel.stockOnHand = stockOnHand;
    } else {
      productStockLevel = new ProductStockLevel({
        productId,
        stockLocationId,
        stockOnHand,
        stockAllocated: 0,
      });
    }
    const saved = await this.connection
      .getRepository(ctx, ProductStockLevel)
      .save(productStockLevel);

    await this.ensureVariantStockLevels(ctx, productId, stockLocationId);
    return saved;
  }

  /**
   * Sets each variant's StockLevel.stockOnHand so that:
   *   stockOnHand - stockAllocated = floor(remaining / weight)
   *
   * We never reset stockAllocated — Vendure manages it.
   * e.g. 50kg pool, 10kg allocated → 250g variant: available=160, stockOnHand=160+stockAllocated
   * e.g. 500-piece pool, 0 allocated → 20-per-pack variant: available=25
   */
  async ensureVariantStockLevels(
    ctx: RequestContext,
    productId: ID,
    stockLocationId: ID,
  ): Promise<void> {
    const psl = await this.connection.getRepository(ctx, ProductStockLevel).findOne({
      where: { productId, stockLocationId },
    });
    if (!psl) return;
    const remaining = psl.stockOnHand - psl.stockAllocated;
    const variants = await this.connection.getRepository(ctx, ProductVariant).find({
      where: { productId, deletedAt: IsNull() },
    });
    const repo = this.connection.getRepository(ctx, StockLevel);
    // One batched lookup for the whole product, read off each variant's
    // option. See shared/resolve-variant-measure.
    const measures = await resolveVariantMeasures(ctx, this.connection, variants);
    // The pool's unit comes from whichever option group the merchant attached:
    // grams for a kg group, pieces for a Nos group. Null means no variant
    // carries a magnitude, so there is nothing to divide the pool by.
    const pool = resolvePoolMeasure(measures);
    if (!pool) return;
    const pooledVariants = variants.filter(v => pool.drawByVariantId.has(String(v.id)));
    if (pooledVariants.length === 0) return;
    // Batch-fetch all existing stock levels for these variants at this location
    const variantIds = pooledVariants.map(v => v.id);
    const existingLevels = await repo
      .createQueryBuilder('sl')
      .where('sl.productVariantId IN (:...variantIds)', { variantIds })
      .andWhere('sl.stockLocationId = :stockLocationId', { stockLocationId })
      .getMany();
    const existingMap = new Map(existingLevels.map(sl => [String(sl.productVariantId), sl]));
    const toSave: StockLevel[] = [];
    const toInsert: { productVariantId: any; stockLocationId: any; stockOnHand: number; stockAllocated: number }[] = [];
    for (const variant of pooledVariants) {
      // Non-null: pooledVariants was filtered on the same map above.
      const draw = pool.drawByVariantId.get(String(variant.id))!;
      const calculated = Math.max(0, Math.floor(remaining / draw));
      const existing = existingMap.get(String(variant.id));
      if (existing) {
        existing.stockOnHand = calculated + existing.stockAllocated;
        toSave.push(existing);
      } else {
        toInsert.push({
          productVariantId: variant.id,
          stockLocationId,
          stockOnHand: calculated,
          stockAllocated: 0,
        });
      }
    }
    // Batch-save existing levels
    if (toSave.length > 0) {
      await repo.save(toSave);
    }
    // Batch-insert new levels
    if (toInsert.length > 0) {
      await repo
        .createQueryBuilder()
        .insert()
        .into(StockLevel)
        .values(toInsert)
        .execute();
    }
  }

  /**
   * Rebuilds a pool's `stockAllocated` from the orders that actually hold stock,
   * discarding whatever the running total had drifted to.
   *
   * Needed because the pool total is an accumulator, and accumulators inherit
   * every bug upstream of them. Three fed this one: duplicate Razorpay
   * settlements re-running allocation for the same line (a single fulfillment
   * then released it once), non-atomic decrements losing writes under
   * concurrency, and sales made while the product's toggle was off, which the
   * strategy skips entirely. Product 168 ended up reserving 21.75 kg against
   * 1.75 kg of real orders and read as sold out with a full shelf.
   *
   * Truth is recomputed as: for every line of every PLACED, non-cancelled
   * order, the quantity not yet fulfilled, times that variant's pool draw.
   * Fulfilled units are gone from the pool's on-hand already (forSale took
   * both), so counting them again would reserve stock twice. Cancelled orders
   * released theirs. Carts (`AddingItems`) never allocated in the first place.
   *
   * Deliberately NOT derived from `stock_movement`: that ledger faithfully
   * records the duplicate allocations, so rebuilding from it would reproduce
   * the very inflation this repairs.
   */
  async reconcileAllocated(
    ctx: RequestContext,
    productId: ID,
  ): Promise<{ status: 'reconciled' | 'no-pool' | 'no-measure' | 'ambiguous'; before: number; after: number }> {
    const repo = this.connection.getRepository(ctx, ProductStockLevel);
    const pools = await repo.find({ where: { productId } });
    if (pools.length === 0) {
      return { status: 'no-pool', before: 0, after: 0 };
    }
    if (pools.length > 1) {
      // Order lines record no stock location, so with several pool rows there is
      // no honest way to say which one holds a given reservation. Guessing would
      // move stock between branches; every product in this catalogue has exactly
      // one row, so this is a guard, not a workflow.
      Logger.warn(
        `[product-pool] product ${productId} has ${pools.length} pool rows — cannot attribute ` +
        `allocations to a location, skipping reconciliation.`,
        loggerCtx,
      );
      return { status: 'ambiguous', before: 0, after: 0 };
    }
    const pool = pools[0];
    const allocated = await this.calculateAllocated(ctx, productId);
    if (allocated == null) {
      return { status: 'no-measure', before: pool.stockAllocated, after: pool.stockAllocated };
    }
    const before = pool.stockAllocated;
    if (before !== allocated) {
      await repo.update({ id: pool.id }, { stockAllocated: allocated });
      Logger.info(
        `[product-pool] product ${productId}: stockAllocated ${before} -> ${allocated} ` +
        `(rebuilt from open orders)`,
        loggerCtx,
      );
    }
    // The variant mirror is derived from the pool, so it is stale the moment the
    // pool changes. Re-deriving here is what puts the product back on sale.
    await this.ensureVariantStockLevels(ctx, productId, pool.stockLocationId);
    return { status: 'reconciled', before, after: allocated };
  }

  /**
   * What a product's pool SHOULD have reserved, in its own base unit.
   *
   * Separate from `reconcileAllocated` so the repair script can preview every
   * pool before writing to any of them — a figure that moves stock across a
   * live catalogue deserves to be read first. Returns null when no variant
   * carries a measure, since there is then no draw to multiply by.
   */
  async calculateAllocated(ctx: RequestContext, productId: ID): Promise<number | null> {
    const variants = await this.connection.getRepository(ctx, ProductVariant).find({
      where: { productId, deletedAt: IsNull() },
    });
    const measures = await resolveVariantMeasures(ctx, this.connection, variants);
    const poolMeasure = resolvePoolMeasure(measures);
    if (!poolMeasure) return null;
    const outstanding = await this.getOutstandingQuantities(
      ctx,
      variants.map(v => v.id),
    );
    let allocated = 0;
    outstanding.forEach((quantity, variantId) => {
      const draw = poolMeasure.drawByVariantId.get(variantId);
      if (!draw || draw <= 0) return;
      allocated += quantity * draw;
    });
    return allocated;
  }

  /**
   * Units still reserved per variant: ordered, not yet fulfilled, not cancelled.
   *
   * `line.quantity` rather than `orderPlacedQuantity` on purpose — cancelling
   * part of a line lowers `quantity`, and a cancelled unit is not reserved.
   */
  private async getOutstandingQuantities(
    ctx: RequestContext,
    variantIds: ID[],
  ): Promise<Map<string, number>> {
    const outstanding = new Map<string, number>();
    if (variantIds.length === 0) return outstanding;
    // Correlated subquery rather than a derived table joined on order_line.id.
    // The derived-table form made MySQL aggregate the whole order_line_reference
    // table (389k rows) once PER PRODUCT — 3 seconds each, 20+ minutes to walk
    // the catalogue, and the same cost would have landed in the Re-sync button.
    // Correlated, it is an index lookup on orderLineId per line instead.
    const fulfillmentLineTable = this.connection.rawConnection.getMetadata(FulfillmentLine).tableName;
    const rows = await this.connection
      .getRepository(ctx, OrderLine)
      .createQueryBuilder('line')
      .select('line.productVariantId', 'variantId')
      .addSelect(
        `SUM(GREATEST(0, line.quantity - COALESCE((` +
          `SELECT SUM(ref.quantity) FROM \`${fulfillmentLineTable}\` ref ` +
          `WHERE ref.orderLineId = line.id AND ref.discriminator = :fulfillmentDiscriminator` +
          `), 0)))`,
        'outstanding',
      )
      .setParameter('fulfillmentDiscriminator', 'FulfillmentLine')
      .innerJoin('line.order', 'ord')
      .where('line.productVariantId IN (:...variantIds)', { variantIds })
      // Allocation happens at placement; an unplaced cart holds nothing.
      .andWhere('ord.orderPlacedAt IS NOT NULL')
      .andWhere('ord.state NOT IN (:...releasedStates)', { releasedStates: RELEASED_ORDER_STATES })
      .groupBy('line.productVariantId')
      .getRawMany();
    for (const row of rows) {
      outstanding.set(String(row.variantId), parseInt(row.outstanding, 10) || 0);
    }
    return outstanding;
  }

  /**
   * Returns the remaining weight available for a product across all stock locations.
   */
  async getRemainingWeight(ctx: RequestContext, productId: ID): Promise<number> {
    const result = await this.connection.getRepository(ctx, ProductStockLevel)
      .createQueryBuilder('psl')
      .select('SUM(psl.stockOnHand - psl.stockAllocated)', 'remaining')
      .where('psl.productId = :productId', { productId })
      .getRawOne();
    return parseInt(result?.remaining, 10) || 0;
  }

  /**
   * Checks if a product uses product-level stock.
   * Returns true if ProductStockLevel records exist for this product.
   */
  async isProductLevelStock(ctx: RequestContext, productId: ID): Promise<boolean> {
    const count = await this.connection
      .getRepository(ctx, ProductStockLevel)
      .count({ where: { productId } });
    return count > 0;
  }
}
