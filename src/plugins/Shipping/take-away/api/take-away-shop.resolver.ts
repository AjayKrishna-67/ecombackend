import { Args, Mutation, Resolver } from '@nestjs/graphql';
import {
    ACTIVE_ORDER_INPUT_FIELD_NAME,
    ActiveOrderService,
    Allow,
    Ctx,
    ID,
    isGraphQlErrorResult,
    Order,
    OrderService,
    Permission,
    RequestContext,
    ShippingMethod,
    Transaction,
    TransactionalConnection,
} from '@vendure/core';
import { NoActiveOrderError } from '@vendure/core/dist/common/error/generated-graphql-shop-errors';
import { IsNull } from 'typeorm';

import { isWithinPickupSlot, pickupSlotOf } from '../pickup-slot';

/**
 * Overrides the built-in `setOrderShippingMethod` shop mutation to keep the
 * take-away coupon in sync with the selected shipping method:
 *
 * - Selecting a pickup method whose "Take Away Coupon Code" is set
 *   auto-applies that coupon to the order — the promotion (whose standard
 *   Coupon code field holds the same value) then applies with no customer
 *   action.
 * - Switching to any other method auto-removes previously auto-applied
 *   take-away coupons, dropping the discount.
 * - A pickup time chosen earlier is dropped when the newly selected method's
 *   hours do not contain it (delivery, or another store's hours).
 *
 * Coupon application failures (e.g. no promotion exists for the code) are
 * swallowed — shipping selection must never break because of a promotion
 * misconfiguration.
 */
@Resolver()
export class TakeAwayShopResolver {
    constructor(
        private orderService: OrderService,
        private activeOrderService: ActiveOrderService,
        private connection: TransactionalConnection,
    ) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.Owner)
    async setOrderShippingMethod(@Ctx() ctx: RequestContext, @Args() args: any) {
        if (!ctx.authorizedAsOwnerOnly) {
            return new NoActiveOrderError();
        }
        const sessionOrder = await this.activeOrderService.getActiveOrder(
            ctx,
            args[ACTIVE_ORDER_INPUT_FIELD_NAME],
        );
        if (!sessionOrder) {
            return new NoActiveOrderError();
        }
        const result = await this.orderService.setShippingMethod(ctx, sessionOrder.id, args.shippingMethodId);
        if (isGraphQlErrorResult(result)) {
            return result;
        }
        const methods = await this.connection
            .getRepository(ctx, ShippingMethod)
            .find({ where: { deletedAt: IsNull() } });
        const shippingMethodIds: ID | ID[] = args.shippingMethodId;
        const ids = (Array.isArray(shippingMethodIds) ? shippingMethodIds : [shippingMethodIds]).map(String);
        const selected = methods.filter(m => ids.includes(String(m.id)));

        const synced = await this.syncTakeAwayCoupon(ctx, result, methods, selected);
        return this.clearStalePickupTime(ctx, synced, selected);
    }

    private async syncTakeAwayCoupon(
        ctx: RequestContext,
        order: Order,
        methods: ShippingMethod[],
        selected: ShippingMethod[],
    ): Promise<Order> {
        const codeOf = (m: ShippingMethod) => (m.customFields as any)?.takeAwayCouponCode as string | undefined;
        const allTakeAwayCodes = new Set(methods.map(codeOf).filter((c): c is string => !!c));
        const wantedCodes = selected.map(codeOf).filter((c): c is string => !!c);

        let current = order;
        // Remove take-away coupons that belong to methods no longer selected.
        for (const code of [...(current.couponCodes ?? [])]) {
            if (allTakeAwayCodes.has(code) && !wantedCodes.includes(code)) {
                const res = await this.orderService.removeCouponCode(ctx, current.id, code);
                if (!isGraphQlErrorResult(res)) {
                    current = res;
                }
            }
        }
        // Apply the selected method's take-away coupon.
        for (const code of wantedCodes) {
            if (!(current.couponCodes ?? []).includes(code)) {
                const res = await this.orderService.applyCouponCode(ctx, current.id, code);
                if (!isGraphQlErrorResult(res)) {
                    current = res;
                }
            }
        }
        return current;
    }

    /**
     * A chosen time only means something within the hours it was chosen
     * from. Once the selected methods' hours no longer contain it the order
     * must not carry it, or checkout would confirm a time the store never
     * offered.
     */
    private async clearStalePickupTime(
        ctx: RequestContext,
        order: Order,
        selected: ShippingMethod[],
    ): Promise<Order> {
        const chosen = order.customFields?.pickupTime;
        if (!chosen) {
            return order;
        }
        const stillOffered = selected.some(method => {
            const hours = pickupSlotOf(method);
            return hours !== null && isWithinPickupSlot(chosen, hours);
        });
        if (stillOffered) {
            return order;
        }
        return this.orderService.updateCustomFields(ctx, order.id, { pickupTime: null });
    }
}
