import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { ModifyOrderInput, MutationModifyOrderArgs } from '@vendure/common/lib/generated-types';
import {
    Allow,
    Ctx,
    idsAreEqual,
    isGraphQlErrorResult,
    Logger,
    OrderService,
    Permission,
    Promotion,
    PromotionService,
    RequestContext,
    Transaction,
    TransactionalConnection,
} from '@vendure/core';

import { withCouponProductChanges, withCouponsOfRemovedProductsDropped } from './coupon-product-lines';

/**
 * Vendure's modifyOrder, with the coupon products a draft order would get
 * (see coupon-product-lines.ts). The dashboard's "Modify order" applies and
 * removes coupons through this one mutation, previewing each change with a
 * dry run first, so the preview and the commit are expanded the same way.
 *
 * Which promotions apply after the change is read off a dry run of the
 * admin's own input: that is Vendure's own judgement of the coupon's
 * conditions on the order as modified, in one place. Which applied before
 * is what Vendure recorded on the order, the same list its own activation
 * hooks compare against.
 */
@Resolver()
export class ModifyOrderCouponProductsResolver {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private promotionService: PromotionService,
    ) {}

    @Transaction('manual')
    @Mutation()
    @Allow(Permission.UpdateOrder)
    async modifyOrder(@Ctx() ctx: RequestContext, @Args() args: MutationModifyOrderArgs) {
        const input = await this.withCouponProducts(ctx, args.input);
        // As core does: a dry run, or a refused input, is rolled back.
        await this.connection.startTransaction(ctx);
        const result = await this.orderService.modifyOrder(ctx, input);
        if (input.dryRun || isGraphQlErrorResult(result)) {
            await this.connection.rollBackTransaction(ctx);
        } else {
            await this.connection.commitOpenTransaction(ctx);
        }
        return result;
    }

    /**
     * Every modification is checked, not only one that touches the coupon
     * list: a quantity change alone can make a coupon already on the order
     * start or stop applying, which adds or takes out its products just as
     * it does on a draft. The rows added can themselves change what applies
     * (a coupon's charged product can lift the order over another coupon's
     * minimum), so the dry run is repeated on the expanded input until the
     * applied set settles. An input core refuses is returned as it is, so
     * the real run reports the refusal to the admin.
     */
    private async withCouponProducts(ctx: RequestContext, input: ModifyOrderInput): Promise<ModifyOrderInput> {
        const order = await this.orderService.findOne(ctx, input.orderId);
        if (!order) {
            return input;
        }
        const before = await this.promotionService.getActivePromotionsOnOrder(ctx, order.id);
        const active = await this.promotionService.getActivePromotionsInChannel(ctx);
        // Taking a coupon's last product out takes the coupon out as well.
        const base = withCouponsOfRemovedProductsDropped(input, order, [...before, ...active]);
        let expanded = base;
        let applied: Promotion[] | null = null;
        for (let pass = 0; pass < 3; pass++) {
            const after = await this.promotionsAppliedAfter(ctx, expanded);
            if (!after) {
                return expanded;
            }
            if (applied && sameSet(after, applied)) {
                return expanded;
            }
            applied = after;
            expanded = withCouponProductChanges(base, order, before, applied);
            if (sameRows(expanded, base)) {
                // Nothing to add or take out: the dry run just made is the answer.
                return expanded;
            }
        }
        Logger.warn(
            `Coupon products of order ${String(order.id)} did not settle in 3 dry runs; modifying without them`,
            'ModifyOrderCouponProductsResolver',
        );
        return base;
    }

    /**
     * The promotions that apply once [input] is made, from a rolled-back dry
     * run; null when core refuses the input, which the real run then reports.
     */
    private async promotionsAppliedAfter(ctx: RequestContext, input: ModifyOrderInput): Promise<Promotion[] | null> {
        await this.connection.startTransaction(ctx);
        try {
            const result = await this.orderService.modifyOrder(ctx, { ...input, dryRun: true });
            return isGraphQlErrorResult(result) ? null : result.promotions;
        } finally {
            await this.connection.rollBackTransaction(ctx);
        }
    }
}

function sameSet(a: Promotion[], b: Promotion[]): boolean {
    return a.length === b.length && a.every(p => b.some(q => idsAreEqual(p.id, q.id)));
}

/** Whether [a] carries no add-item or adjust-line rows beyond [b]'s. */
function sameRows(a: ModifyOrderInput, b: ModifyOrderInput): boolean {
    return (
        (a.addItems?.length ?? 0) === (b.addItems?.length ?? 0) &&
        (a.adjustOrderLines?.length ?? 0) === (b.adjustOrderLines?.length ?? 0)
    );
}
