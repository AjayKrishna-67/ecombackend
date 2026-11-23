import { Injectable } from '@nestjs/common';
import { CacheService, RequestContext, TransactionalConnection, ID, ChannelService, Logger } from '@vendure/core';
import { FrequentlyOrderedItem } from '../entities/frequently-ordered-item.entity';

const FREQ_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — refreshed every order placed
const freqTag = (channelId: ID, customerId: ID) => `freq-ordered:${channelId}:${customerId}`;
const freqKey = (channelId: ID, customerId: ID, limit: number) =>
  `freq-ordered:${channelId}:${customerId}:${limit}`;

@Injectable()
export class FrequentlyOrderedService {
  constructor(
    private connection: TransactionalConnection,
    private channelService: ChannelService,
    private cacheService: CacheService,
  ) {}

  async updateFrequentlyOrdered(ctx: RequestContext, customerId: ID, productVariantId: ID) {
    const repository = this.connection.getRepository(ctx, FrequentlyOrderedItem);
    let item = await repository.findOne({
      where: { customerId, productVariantId },
      relations: ['channels'],
    });

    if (!item) {
      item = new FrequentlyOrderedItem();
      item.customerId = customerId;
      item.productVariantId = productVariantId;
      item.orderCount = 0;
    }

    item.orderCount += 1;
    const savedItem = await repository.save(item);

    if (!item.channels?.some(c => c.id === ctx.channelId)) {
      await this.channelService.assignToChannels(ctx, FrequentlyOrderedItem, savedItem.id, [ctx.channelId]);
    }

    await this.cacheService.invalidateTags([freqTag(ctx.channelId, customerId)]);
    Logger.debug(`[FrequentlyOrderedService] Cache invalidated for customer ${customerId}`);

    return savedItem;
  }

  async getFrequentlyOrderedForCustomer(ctx: RequestContext, customerId: ID, limit: number = 10) {
    const cacheKey = freqKey(ctx.channelId, customerId, limit);
    const cached = (await this.cacheService.get(cacheKey)) as FrequentlyOrderedItem[] | undefined;
    if (cached) {
      return cached;
    }
    const items = await this.connection.getRepository(ctx, FrequentlyOrderedItem)
      .createQueryBuilder('item')
      .innerJoin('item.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
      .where('item.customerId = :customerId', { customerId })
      .orderBy('item.orderCount', 'DESC')
      .take(limit)
      .getMany();
    await this.cacheService.set(cacheKey, items as any, {
      ttl: FREQ_CACHE_TTL_MS,
      tags: [freqTag(ctx.channelId, customerId)],
    });
    return items;
  }
}