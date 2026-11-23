import { Resolver, Query } from '@nestjs/graphql';
import { Ctx, RequestContext, TransactionalConnection } from '@vendure/core';
import { Inject } from '@nestjs/common';

@Resolver()
export class FrequentlyOrderedAdminResolver {
  constructor(
    @Inject(TransactionalConnection) private connection: TransactionalConnection
  ) {}

  @Query()
  async productSalesGraph(@Ctx() ctx: RequestContext) {
    const result = await this.connection
      .getRepository(ctx, 'OrderLine')
      .createQueryBuilder('line')
      .innerJoin('line.order', 'order')
      .innerJoin('order.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
      .innerJoin('line.productVariant', 'variant')
      .innerJoin('variant.product', 'product')
      .innerJoin('product.translations', 'translation')
      .where('translation.languageCode = :languageCode', { languageCode: ctx.languageCode })
      .select('product.id', 'productId')
      .addSelect('translation.name', 'productName')
      .addSelect('COUNT(DISTINCT order.id)', 'totalOrders')
      .addSelect('SUM(line.quantity)', 'totalQuantity')
      .groupBy('product.id')
      .addGroupBy('translation.name')
      .orderBy('totalQuantity', 'DESC')
      .getRawMany();

    return result.map((r: any) => ({
      productId: r.productId,
      productName: r.productName,
      totalOrders: Number(r.totalOrders),
      totalQuantity: Number(r.totalQuantity),
    }));
  }
}