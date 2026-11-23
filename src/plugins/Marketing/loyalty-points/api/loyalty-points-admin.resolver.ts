import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, OrderService } from '@vendure/core';
import { MutationCreateLoyaltyPointsTransactionArgs, MutationCreateLoyaltyPointsConfigArgs, MutationUpdateLoyaltyPointsConfigArgs, MutationDeleteLoyaltyPointsConfigArgs } from '../gql/generated';
import { LoyaltyPointsService } from '../service/loyalty-points.service';
import { Order } from '@vendure/core';
import { loyaltyPointsPermission } from '../permissions';

@Resolver()
export class LoyaltyPointsAdminResolver {
  constructor(
    private loyaltyPointsService: LoyaltyPointsService,
    private orderService: OrderService
  ) {}

  @Query()
  @Allow(loyaltyPointsPermission.Permission, Permission.SuperAdmin)
  async loyaltyPointsConfig(@Ctx() ctx: RequestContext) {
    return await this.loyaltyPointsService.getLoyaltyPointsConfig(ctx);
  }

  @Mutation()
  @Allow(loyaltyPointsPermission.Permission, Permission.SuperAdmin)
  createLoyaltyPointsTransaction(
    @Ctx() ctx: RequestContext,
    @Args() { input }: MutationCreateLoyaltyPointsTransactionArgs,
  ) {
    return this.loyaltyPointsService.createPointsAdjustment(ctx, input);
  }

  @Mutation()
  @Allow(loyaltyPointsPermission.Permission, Permission.SuperAdmin)
  createLoyaltyPointsConfig(
    @Ctx() ctx: RequestContext,
    @Args() { input }: MutationCreateLoyaltyPointsConfigArgs,
  ) {
    return this.loyaltyPointsService.createLoyaltyPointsConfig(ctx, input);
  }

  @Mutation()
  @Allow(loyaltyPointsPermission.Permission, Permission.SuperAdmin)
  updateLoyaltyPointsConfig(
    @Ctx() ctx: RequestContext,
    @Args() { id, input }: MutationUpdateLoyaltyPointsConfigArgs,
  ) {
    return this.loyaltyPointsService.updateLoyaltyPointsConfig(ctx, id, input);
  }

  @Mutation()
  @Allow(loyaltyPointsPermission.Permission, Permission.SuperAdmin)
  deleteLoyaltyPointsConfig(
    @Ctx() ctx: RequestContext,
    @Args() { id }: MutationDeleteLoyaltyPointsConfigArgs,
  ) {
    return this.loyaltyPointsService.deleteLoyaltyPointsConfig(ctx, id);
  }

//   @Mutation()
//   @Allow(Permission.UpdateOrder)
//   async addPaymentToOrder(@Ctx() ctx: RequestContext, @Args() { input }: { input: any }): Promise<Order> {
//     // Use OrderService to add payment
//     const order = await this.orderService.addPaymentToOrder(ctx, input);

//     // Apply points after payment
//     await this.loyaltyPointsService.applyPointsAfterPayment(ctx, order);

//     // Return the updated order using a service method
//     return await this.loyaltyPointsService.getUpdatedOrder(ctx, order.id);
//   }
}