import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { MutationAdjustDraftOrderLineArgs, MutationRemoveDraftOrderLineArgs } from '@vendure/common/lib/generated-types';
import {
    Allow,
    Ctx,
    ID,
    idsAreEqual,
    isGraphQlErrorResult,
    OrderService,
    Permission,
    PromotionService,
    RequestContext,
    Transaction,
} from '@vendure/core';

import { freeFromPromotionOf, removeCouponWhoseProductsAreGone } from './coupon-product-lines';

/**
 * Vendure's removeDraftOrderLine and adjustDraftOrderLine, except that
 * taking the last of a coupon's products off the draft takes the coupon off
 * as well (see removeCouponWhoseProductsAreGone). Applying the coupon added
 * the product; removing the product is the admin saying no to the coupon.
 */
@Resolver()
export class DraftOrderCouponProductsResolver {
    constructor(
        private orderService: OrderService,
        private promotionService: PromotionService,
    ) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.CreateOrder)
    async removeDraftOrderLine(@Ctx() ctx: RequestContext, @Args() args: MutationRemoveDraftOrderLineArgs) {
        return this.removeLine(ctx, args.orderId, args.orderLineId);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.CreateOrder)
    async adjustDraftOrderLine(@Ctx() ctx: RequestContext, @Args() { orderId, input }: MutationAdjustDraftOrderLineArgs) {
        if (input.quantity === 0) {
            return this.removeLine(ctx, orderId, input.orderLineId);
        }
        return this.orderService.adjustOrderLine(
            ctx,
            orderId,
            input.orderLineId,
            input.quantity,
            (input as { customFields?: Record<string, unknown> }).customFields,
        );
    }

    private async removeLine(ctx: RequestContext, orderId: ID, orderLineId: ID) {
        const before = await this.orderService.findOne(ctx, orderId);
        const line = before?.lines.find(l => idsAreEqual(l.id, orderLineId));
        const promotionId = line ? freeFromPromotionOf(line) : null;
        const result = await this.orderService.removeItemFromOrder(ctx, orderId, orderLineId);
        if (isGraphQlErrorResult(result) || promotionId == null) {
            return result;
        }
        return removeCouponWhoseProductsAreGone(
            ctx,
            { orderService: this.orderService, promotionService: this.promotionService },
            result,
            promotionId,
        );
    }
}
