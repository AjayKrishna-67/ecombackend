import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Ctx, Order, RequestContext } from '@vendure/core';
import { LoyaltyPointsService } from '../service/loyalty-points.service';

@Resolver()
export class LoyaltyPointsShopResolver {
  constructor(private rewardsService: LoyaltyPointsService) {}

  @Mutation()
  applyLoyaltyPointsToActiveOrder(
    @Ctx() ctx: RequestContext,
    @Args('amount') amount: number
  ) {
    return this.rewardsService.applyLoyaltyPointsToActiveOrder(ctx, amount);
  }

  @Mutation(() => Order, { nullable: true })
  removeLoyaltyPointsFromActiveOrder(
    @Ctx() ctx: RequestContext,
  ): Promise<Order | undefined> {
    return this.rewardsService.removeLoyaltyPointsFromActiveOrder(ctx);
  }

  @Query()
  async loyaltyPointsConfig(@Ctx() ctx: RequestContext) {
    return this.rewardsService.getLoyaltyPointsConfig(ctx);
  }
}