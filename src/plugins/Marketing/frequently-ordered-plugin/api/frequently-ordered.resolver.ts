// src/plugins/Marketing /frequently-ordered-plugin/api/frequently-ordered.resolver.ts

import { Injectable } from '@nestjs/common';
import { EventBus, OrderPlacedEvent, TransactionalConnection } from '@vendure/core';
import { FrequentlyOrderedItem } from '../entities/frequently-ordered-item.entity';

@Injectable()
export class FrequentlyOrderedSubscriber {
  constructor(
    private eventBus: EventBus,
    private connection: TransactionalConnection,
  ) {
    this.eventBus.ofType(OrderPlacedEvent).subscribe(event => {
      this.handleOrderPlaced(event);
    });
  }

  private async handleOrderPlaced(event: OrderPlacedEvent) {
    const { order } = event;
    if (!order.customer) return;

    const repo = this.connection.getRepository(FrequentlyOrderedItem);

    for (const line of order.lines) {
      const variantId = line.productVariant.id;
      const customerId = order.customer.id;

      // upsert into FrequentlyOrderedItem
      let item = await repo.findOne({
        where: { customerId, productVariantId: variantId },
      });

      if (item) {
        item.orderCount += line.quantity;
      } else {
        item = repo.create({
          customerId,
          productVariantId: variantId,
          orderCount: line.quantity,
        });
      }

      await repo.save(item);
    }
  }
}