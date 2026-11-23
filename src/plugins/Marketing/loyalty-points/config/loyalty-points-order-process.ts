//src/plugins/Marketing /loyalty-points/config/loyalty-points-order-process.ts

import { OrderProcess, Injector, OrderState, OrderTransitionData } from '@vendure/core';
import { LoyaltyPointsService } from '../service/loyalty-points.service';

export class LoyaltyPointsOrderProcess implements OrderProcess<OrderState> {
  private loyaltyPointsService: LoyaltyPointsService;

  init(injector: Injector) {
    this.loyaltyPointsService = injector.get(LoyaltyPointsService);
  }

  async onTransitionEnd(fromState: OrderState, toState: OrderState, data: OrderTransitionData) {
    if (fromState === 'AddingItems' && toState === 'ArrangingPayment') {
      // Only apply session-scoped loyalty during a REAL shop-side checkout, where the
      // request carries an active order + user. When this transition is driven
      // server-side (Razorpay webhook settlement, reconciliation cron, admin self-heal)
      // the ctx has no active session, so applyLoyaltyPointsToActiveOrder would throw
      // 'No active order or user found' and ROLL BACK the transition — permanently
      // stranding a paid order in AddingItems. The points were already applied during
      // the customer's original checkout, so re-applying here would also double-count.
      //
      // Channels without a loyalty programme (no LoyaltyPointsConfig) have no
      // points to apply; calling apply there throws and blocks every checkout.
      if (
        data.ctx.session?.activeOrderId &&
        data.ctx.activeUserId &&
        (await this.loyaltyPointsService.getLoyaltyPointsConfig(data.ctx))
      ) {
        const order = await this.loyaltyPointsService.applyLoyaltyPointsToActiveOrder(
          data.ctx,
          data.order.customFields.loyaltyPointsUsed || 0,
        );
        if (order) {
          data.order.customFields.loyaltyPointsUsed = order.customFields.loyaltyPointsUsed;
        }
      }
    }
    if (
      toState === 'PaymentSettled' &&
      (fromState === 'ArrangingPayment' || fromState === 'PaymentAuthorized')
    ) {
      const order = data.order;
      await this.loyaltyPointsService.addPointsFromOrder(data.ctx, order);
      const pointsEarned = await this.loyaltyPointsService.getPointsEarnedOnOrder(data.ctx, order.id);
      await this.loyaltyPointsService.updateOrderWithPointsEarned(data.ctx, order, pointsEarned);
    }
    if (toState === 'Cancelled') {
      await this.loyaltyPointsService.handleOrderCancelled(data.ctx, data.order);
    }
  }
}