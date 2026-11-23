import { Injectable } from '@nestjs/common';
import { EventBus, OrderPlacedEvent, TransactionalConnection, EntityHydrator, Logger, ChannelService } from '@vendure/core';
import { In } from 'typeorm';
import { FrequentlyOrderedItem } from '../entities/frequently-ordered-item.entity';

@Injectable()
export class FrequentlyOrderedSubscriber {
  constructor(
    private eventBus: EventBus,
    private connection: TransactionalConnection,
    private entityHydrator: EntityHydrator,
    private channelService: ChannelService
  ) {
    this.eventBus.ofType(OrderPlacedEvent).subscribe(async (event) => {
      try {
        await this.handleOrderPlaced(event);
      } catch (error: any) {
        Logger.error(`Error in FrequentlyOrderedSubscriber: ${error.message}`, 'FrequentlyOrderedPlugin');
      }
    });
  }

  private async handleOrderPlaced(event: OrderPlacedEvent) {
    const { ctx, order } = event;

    await this.entityHydrator.hydrate(ctx, order, {
      relations: ['lines', 'lines.productVariant', 'customer'],
    });

    if (!order.customer || !order.lines?.length) return;

    const repo = this.connection.getRepository(ctx, FrequentlyOrderedItem);
    const customerId = order.customer.id;

    // Collect all variant IDs from order lines
    const variantIds = order.lines
      .filter(line => line.productVariant)
      .map(line => line.productVariant.id);

    if (variantIds.length === 0) return;

    // Batch-fetch all existing FrequentlyOrderedItems for this customer + these variants
    const existingItems = await repo.find({
      where: { customerId, productVariantId: In(variantIds) },
      relations: ['channels'],
    });
    const existingMap = new Map(existingItems.map(item => [String(item.productVariantId), item]));

    // Process all lines, collecting items to save and channels to assign
    const itemsToSave: FrequentlyOrderedItem[] = [];
    const channelAssignments: { itemId: any }[] = [];

    for (const line of order.lines) {
      if (!line.productVariant) continue;
      const variantId = line.productVariant.id;
      const existing = existingMap.get(String(variantId));

      if (existing) {
        existing.orderCount += line.quantity;
        itemsToSave.push(existing);
        if (!existing.channels.some(c => c.id === ctx.channelId)) {
          channelAssignments.push({ itemId: existing.id });
        }
      } else {
        const newItem = repo.create({
          customerId,
          productVariantId: variantId,
          orderCount: line.quantity,
        });
        const saved = await repo.save(newItem);
        channelAssignments.push({ itemId: saved.id });
        existingMap.set(String(variantId), saved);
      }
    }

    // Batch-save all updated items
    if (itemsToSave.length > 0) {
      await repo.save(itemsToSave);
    }

    // Batch channel assignments
    for (const assignment of channelAssignments) {
      await this.channelService.assignToChannels(ctx, FrequentlyOrderedItem, assignment.itemId, [ctx.channelId]);
    }
  }
}