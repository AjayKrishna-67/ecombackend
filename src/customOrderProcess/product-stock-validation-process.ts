import {
  Injector,
  Logger,
  OrderProcess,
  OrderState,
  ProductVariant,
  TransactionalConnection,
} from '@vendure/core';
import { IsNull } from 'typeorm';
import { isPooled } from '../plugins/Stock/shared/is-pooled';
import { resolveVariantMeasures } from '../plugins/Stock/shared/resolve-variant-measure';
import {
    displayUnitForBase,
    PoolMeasure,
    poolUnitLabel,
    resolvePoolMeasure,
} from '../plugins/Stock/shared/pool-measure';
import { fromBase } from '../plugins/Stock/shared/stock-units';
import { ProductStockLevel } from '../plugins/Stock/product-stock/entities/product-stock-level.entity';

const loggerCtx = 'ProductStockValidationProcess';

let conn: TransactionalConnection;

/**
 * Validates product-level stock availability when transitioning
 * from AddingItems → ArrangingPayment.
 *
 * Groups all order lines by product, sums the total pool draw needed in that
 * product's own base unit (grams for a kg-authored product, pieces for a
 * Nos-authored one), and returns a single error listing ALL insufficient items.
 *
 * This is the last guard before an order is placed, so a unit it cannot measure
 * is a unit it cannot protect: reading `grams` here meant every counted product
 * skipped validation entirely and could be oversold at checkout.
 */

export const productStockValidationProcess: OrderProcess<OrderState> = {
  init(injector: Injector) {
    conn = injector.get(TransactionalConnection);
  },

  async onTransitionStart(fromState, toState, data) {
    if (fromState !== 'AddingItems' || toState !== 'ArrangingPayment') {
      return;
    }
    const { ctx, order } = data;
    const orderLines = order.lines;
    if (!orderLines || orderLines.length === 0) return;
    // Group order lines by productId with weight info
    const productLineMap = new Map<
      string,
      { productName: string; totalWeightNeeded: number; baseUnit: PoolMeasure['baseUnit']; lines: Array<{ variantName: string; quantity: number; weight: number }> }
    >();
    const poolByProduct = new Map<string, PoolMeasure | null>();
    for (const line of orderLines) {
      const variantId = (line as any).productVariantId ?? line.productVariant?.id;
      if (!variantId) continue;
      const variant = await conn.getRepository(ctx, ProductVariant).findOne({
        where: { id: variantId },
        // `options` is loaded here so the measure resolver reads it in memory
        // instead of firing its own query per line.
        relations: ['translations', 'product', 'product.translations', 'options'],
      });
      if (!variant) continue;
      const productId = String(variant.productId);
      const hasProductStock = await conn
        .getRepository(ctx, ProductStockLevel)
        .count({ where: { productId: variant.productId } });
      // The row is only half the question — the `productStockEnabled` toggle is
      // the other half, and the strategy has always read it. Guarding on the row
      // alone made a toggled-off product addable to a cart yet impossible to
      // check out, because this guard kept reading a pool the seller side had
      // already stopped maintaining. See shared/is-pooled.ts.
      if (!isPooled(variant.product?.customFields, hasProductStock > 0)) continue;
      // Resolved once per product and reused across its lines. The pool's base
      // unit belongs to the product's option group, so it cannot be read off a
      // single variant.
      if (!poolByProduct.has(productId)) {
        const siblings = await conn
          .getRepository(ctx, ProductVariant)
          .find({ where: { productId: variant.productId, deletedAt: IsNull() } });
        poolByProduct.set(
          productId,
          resolvePoolMeasure(await resolveVariantMeasures(ctx, conn, siblings)),
        );
      }
      const pool = poolByProduct.get(productId) ?? null;
      const weight = pool?.drawByVariantId.get(String(variant.id));
      if (!pool || !weight || weight <= 0) continue;
      const langCode = ctx.languageCode;
      const variantTranslation = variant.translations.find((t: any) => t.languageCode === langCode)
        ?? variant.translations[0];
      const variantName = variantTranslation?.name ?? variant.sku;
      const productTranslation = variant.product?.translations?.find((t: any) => t.languageCode === langCode)
        ?? variant.product?.translations?.[0];
      const productName = productTranslation?.name ?? `Product #${productId}`;
      const lineWeight = line.quantity * weight;
      if (!productLineMap.has(productId)) {
        productLineMap.set(productId, { productName, totalWeightNeeded: 0, baseUnit: pool.baseUnit, lines: [] });
      }
      const entry = productLineMap.get(productId)!;
      entry.totalWeightNeeded += lineWeight;
      entry.lines.push({ variantName, quantity: line.quantity, weight });
    }
    if (productLineMap.size === 0) return;
    // Check each product's available stock
    const insufficientItems: string[] = [];
    for (const [productId, { productName, totalWeightNeeded, baseUnit, lines }] of productLineMap) {
      const totals = await conn
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
      if (remaining < totalWeightNeeded) {
        // Reported in the product's own unit; a piece pool must not tell a
        // shopper they ordered "0.05 kg" of lemons.
        const displayUnit = displayUnitForBase(baseUnit);
        const label = poolUnitLabel(baseUnit);
        const have = fromBase(Math.max(0, remaining), displayUnit);
        const need = fromBase(totalWeightNeeded, displayUnit);
        const itemsList = lines.map(l => `${l.variantName} x${l.quantity}`).join(', ');
        insufficientItems.push(
          `"${productName}": you added ${itemsList} (needs ${need} ${label}) but only ${have} ${label} is available`,
        );
        Logger.warn(
          `Stock validation failed for "${productName}" (${productId}): ` +
          `need ${need} ${label}, have ${have} ${label}. Items: ${itemsList}`,
          loggerCtx,
        );
      }
    }
    if (insufficientItems.length > 0) {
      return `Insufficient stock — ${insufficientItems.join('; ')}`;
    }
  },
};
