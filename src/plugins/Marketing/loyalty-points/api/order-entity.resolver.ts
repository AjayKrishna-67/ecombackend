import { Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { Order } from '@vendure/core';
import { LoyaltyPointsService } from '../service/loyalty-points.service';
import { Ctx, RequestContext } from '@vendure/core';
import { Logger } from '@nestjs/common';

@Resolver('Order')
export class OrderEntityResolver {
  constructor(private loyaltyPointsService: LoyaltyPointsService) {}

  @ResolveField()
  async loyaltyPointsEarned(@Ctx() ctx: RequestContext, @Parent() order: Order): Promise<number> {
    Logger.log(`Resolving loyaltyPointsEarned for order ${order.code}: ${order.customFields.loyaltyPointsEarned}`, 'LoyaltyPointsPlugin');
    return this.loyaltyPointsService.getPointsEarnedOnOrder(ctx, order.id);
  }

  @ResolveField()
  loyaltyPointsUsed(@Parent() order: Order): number {
    return order.customFields.loyaltyPointsUsed || 0;
  }
}