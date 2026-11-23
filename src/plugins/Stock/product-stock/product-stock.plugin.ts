import { OnApplicationBootstrap } from '@nestjs/common';
import {
  EventBus,
  Logger,
  PluginCommonModule,
  Product,
  ProductEvent,
  ProductVariantEvent,
  RequestContext,
  TransactionalConnection,
  VendurePlugin,
} from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import gql from 'graphql-tag';
import { isPoolToggleOn } from '../shared/is-pooled';
import { ProductStockLevel } from './entities/product-stock-level.entity';
import { ProductStockService } from './services/product-stock.service';
import { AdminProductStockResolver } from './api/resolver/admin/product-stock.resolver';
import { ProductStockLocationStrategy } from './strategies/product-stock-location.strategy';

const loggerCtx = 'ProductStockPlugin';

const adminSchemaExtension = gql`
  type ProductStockLevel {
    id: ID!
    createdAt: DateTime!
    updatedAt: DateTime!
    productId: ID!
    stockLocationId: ID!
    stockOnHand: Int!
    stockAllocated: Int!
  }

  type VariantStockInfo {
    variantId: ID!
    sku: String!
    name: String!
    weight: Int!
    availableStock: Int!
    stockOnHand: Int!
    stockAllocated: Int!
  }

  """
  A variant of a pooled product that takes no part in the pool, and why.

  A pool is one integer in one base unit, so a variant measured in a different
  base cannot draw from it, and one with no measurement at all has nothing to
  divide by. Both were previously dropped in silence -- the variant simply did
  not appear in the overview -- which reads as "stock vanished" rather than
  "this variant is authored in the wrong unit".
  """
  type ExcludedVariantInfo {
    variantId: ID!
    sku: String!
    name: String!
    """What the variant resolved to, e.g. '250 g'. Null when nothing resolved."""
    measure: String
    """Which layer supplied it: 'option', 'variant' (deprecated custom field) or 'none'."""
    source: String!
    """'UNIT_MISMATCH' when it measures in another base, 'NO_MEASUREMENT' when it has none."""
    reason: String!
  }

  type ProductStockOverview {
    productId: ID!
    stockOnHand: Int!
    stockAllocated: Int!
    availableWeight: Int!
    """
    What the pool integers above count: 'g', 'ml' or 'piece'. Derived from the
    option group attached to this product's variants -- a kg group gives a gram
    pool, a Nos group gives a piece pool -- so it is never stored and never
    needs a migration. Defaults to 'g' when nothing is measured.
    """
    baseUnit: String!
    variants: [VariantStockInfo!]!
    """
    Variants of this product that the pool leaves out. Empty is the healthy
    state; anything here is a data conflict for a human to resolve.
    """
    excludedVariants: [ExcludedVariantInfo!]!
  }

  input SetProductStockInput {
    productId: ID!
    stockLocationId: ID!
    stockOnHand: Int!
  }

  extend type Query {
    productStockLevels(productId: ID!): [ProductStockLevel!]!
    productStockOverview(productId: ID!): ProductStockOverview!
  }

  extend type Mutation {
    setProductStock(input: SetProductStockInput!): ProductStockLevel!
    removeProductStock(productId: ID!): Boolean!
    """Re-sync variant StockLevels from product-level stock. Use after desync issues."""
    resyncProductStock(productId: ID!): Boolean!
  }
`;

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [ProductStockLevel],
  providers: [ProductStockService],
  adminApiExtensions: {
    schema: adminSchemaExtension,
    resolvers: [AdminProductStockResolver],
  },
  configuration: config => {
    config.catalogOptions.stockLocationStrategy = new ProductStockLocationStrategy();
    return config;
  },
  dashboard: './dashboard/index.tsx',
  compatibility: '^3.6.3',
})
export class ProductStockPlugin implements OnApplicationBootstrap {
  constructor(
    private readonly eventBus: EventBus,
    private readonly productStockService: ProductStockService,
    private readonly connection: TransactionalConnection,
  ) {}

  onApplicationBootstrap(): void {
    this.restoreMirrorAfterVariantEdits();
    this.reconcileWhenPoolSwitchedOn();
  }

  /**
   * Re-derives a pooled product's variant StockLevels whenever someone saves a
   * variant.
   *
   * The variant Stock box stays editable on both admin frontends, and for a
   * pooled product what it holds is output, not input: the pool divided by the
   * variant's draw. Typing into it changed a number the next pool movement
   * would overwrite anyway — but "the next pool movement" could be days away,
   * so staff saw the figure stick, believed stock was restocked, and shoppers
   * kept hitting an empty pool at checkout. That is how a full shelf read as
   * sold out for three weeks.
   *
   * Snapping it back immediately makes the contract visible: the number returns
   * to what the pool says, in front of the person who typed it, rather than
   * quietly reverting later.
   */
  private restoreMirrorAfterVariantEdits(): void {
    this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
      if (event.type !== 'updated') return;
      const productIds = [...new Set(event.entity.map(variant => String(variant.productId)))];
      void this.forEachPooledProduct(event.ctx, productIds, async (ctx, productId) => {
        const levels = await this.productStockService.getProductStockLevels(ctx, productId);
        // Toggle on but no pool row is not a pool — the merchant may have just
        // pressed "Remove all stock", which hands the product back to
        // per-variant stock. Overwriting the variant row from a pool that no
        // longer exists would erase the figure they then legitimately typed,
        // and claiming in the log that anything was "re-derived" would be false.
        if (levels.length === 0) return;
        for (const level of levels) {
          await this.productStockService.ensureVariantStockLevels(ctx, productId, level.stockLocationId);
        }
        Logger.info(
          `[product-pool] product ${productId}: variant stock levels re-derived from the pool ` +
          `after a variant edit (the pool, not the variant row, holds this product's stock)`,
          loggerCtx,
        );
      });
    });
  }

  /**
   * Rebuilds the reservation total when a merchant switches the pool back on.
   *
   * While the toggle is off the strategy leaves the pool alone, so sales and
   * releases in that window never reach it and `stockAllocated` freezes at
   * whatever it held. Trusting that figure on re-enable would reserve stock
   * against orders that were delivered weeks ago — 623 kg sat stranded exactly
   * this way across 56 products.
   */
  private reconcileWhenPoolSwitchedOn(): void {
    this.eventBus.ofType(ProductEvent).subscribe(event => {
      if (event.type !== 'updated') return;
      const input = event.input as { customFields?: { productStockEnabled?: unknown } } | undefined;
      // Only when this very save turned it on: reconciliation is two queries,
      // and products are saved constantly for unrelated reasons.
      if (!input || !isPoolToggleOn(input.customFields)) return;
      const productId = String(event.entity.id);
      void this.productStockService
        .reconcileAllocated(event.ctx, productId)
        .then(result => {
          if (result.status === 'reconciled' && result.before !== result.after) {
            Logger.info(
              `[product-pool] product ${productId}: pool switched on, stockAllocated rebuilt ` +
              `${result.before} -> ${result.after}`,
              loggerCtx,
            );
          }
        })
        .catch((e: unknown) => {
          Logger.error(
            `[product-pool] product ${productId}: reconciliation on enable failed: ${String(e)}`,
            loggerCtx,
          );
        });
    });
  }

  /**
   * Runs `work` for each of `productIds` whose pool toggle is on, swallowing
   * failures into the log.
   *
   * Event handlers run outside the request that triggered them: throwing here
   * would surface as an unhandled rejection with no caller to receive it, and
   * a failed mirror refresh must never roll back the variant edit that was
   * already committed.
   */
  private async forEachPooledProduct(
    ctx: RequestContext,
    productIds: string[],
    work: (ctx: RequestContext, productId: string) => Promise<void>,
  ): Promise<void> {
    for (const productId of productIds) {
      try {
        const product = await this.connection
          .getRepository(ctx, Product)
          .findOne({ where: { id: productId } });
        if (!product || !isPoolToggleOn(product.customFields)) continue;
        await work(ctx, productId);
      } catch (e: unknown) {
        Logger.error(`[product-pool] product ${productId}: ${String(e)}`, loggerCtx);
      }
    }
  }

  static UiExtensions: AdminUiExtension = {
    id: 'product-stock-ui',
    extensionPath: path.join(__dirname, 'ui'),
    providers: ['providers.ts'],
  };
}
