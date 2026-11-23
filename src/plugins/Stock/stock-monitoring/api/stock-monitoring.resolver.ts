import { Query, Resolver, Args } from '@nestjs/graphql';
import {
  Ctx,
  ProductVariant,
  RequestContext,
  TransactionalConnection,
  Permission,
  Allow,
} from '@vendure/core';
import { In } from 'typeorm';
import { StockMonitoringPlugin } from '../stock-monitoring.plugin';

@Resolver()
export class StockMonitoringResolver {
  constructor(private connection: TransactionalConnection) {}

  @Query()
  @Allow(Permission.ReadCatalog)
  async productVariantsWithLowStock(
    @Ctx() ctx: RequestContext,
    @Args('skip') skip?: number,
    @Args('take') take?: number
  ): Promise<{ items: ProductVariant[]; totalItems: number }> {
    const threshold = StockMonitoringPlugin.threshold;
    const actualTake = take ?? 10;
    const actualSkip = skip ?? 0;

    // 1. Build the Base Query
    const qb = this.connection
      .getRepository(ctx, ProductVariant)
      .createQueryBuilder('variant')
      .select('variant.id', 'id')
      .leftJoin('variant.stockLevels', 'stockLevel')
      .leftJoin('variant.product', 'product')      // Join Product
      .leftJoin('product.channels', 'channel')     // Join Channels
      .where('variant.enabled = true')             // Variant must be enabled
      .andWhere('product.enabled = true')          // ✅ OPTIMIZATION: Product must be enabled
      .andWhere('variant.deletedAt IS NULL')
      .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
      .groupBy('variant.id')
      .having(
        '(SUM(stockLevel.stockOnHand) - SUM(stockLevel.stockAllocated)) < :threshold',
        { threshold }
      );

    // 2. Fetch all matching IDs (lightweight: only integer IDs, no entity hydration)
    const allMatchingIds = await qb.getRawMany();
    const totalItems = allMatchingIds.length;

    // 3. Paginate in SQL by slicing IDs then fetching full entities for that page only
    const paginatedIds = allMatchingIds
      .slice(actualSkip, actualSkip + actualTake)
      .map(v => v.id);

    if (paginatedIds.length === 0) {
      return { items: [], totalItems };
    }

    // 4. Fetch full entities for the current page only
    const items = await this.connection
      .getRepository(ctx, ProductVariant)
      .find({
        where: { id: In(paginatedIds) },
        relations: ['stockLevels', 'product'],
        order: { id: 'ASC' },
      });

    return { items, totalItems };
  }
}