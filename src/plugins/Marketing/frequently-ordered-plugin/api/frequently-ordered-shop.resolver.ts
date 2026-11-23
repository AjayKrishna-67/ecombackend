import { Resolver, Query } from '@nestjs/graphql';
import { Ctx, RequestContext, TransactionalConnection } from '@vendure/core';
import { Inject } from '@nestjs/common';
import { FrequentlyOrderedItem } from '../entities/frequently-ordered-item.entity';

@Resolver()
export class FrequentlyOrderedShopResolver {
  constructor(
    @Inject(TransactionalConnection) private connection: TransactionalConnection
  ) {}

  @Query()
  async frequentlyOrderedProducts(@Ctx() ctx: RequestContext) {
    const customer = await this.connection.getRepository(ctx, 'Customer').findOne({
      where: { user: { id: ctx.activeUserId } },
    });
    if (!customer) return [];

    const items = await this.connection.getRepository(ctx, FrequentlyOrderedItem)
      .createQueryBuilder('item')
      .innerJoin('item.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
      .leftJoinAndSelect('item.productVariant', 'productVariant')
      .leftJoinAndSelect('productVariant.product', 'product')
      .leftJoinAndSelect('product.translations', 'translations')
      .leftJoinAndSelect('product.featuredAsset', 'featuredAsset')
      .where('item.customerId = :customerId', { customerId: customer.id })
      .orderBy('item.orderCount', 'DESC')
      .take(10)
      .getMany();

    return items.map(item => ({
      product: item.productVariant.product,
      orderCount: item.orderCount,
    }));
  }
}