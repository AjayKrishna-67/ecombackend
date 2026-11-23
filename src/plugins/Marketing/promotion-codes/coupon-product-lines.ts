import { AddItemInput, ModifyOrderInput } from '@vendure/common/lib/generated-types';
import {
    ID,
    idsAreEqual,
    Injector,
    Order,
    OrderLine,
    OrderService,
    Promotion,
    PromotionService,
    RequestContext,
} from '@vendure/core';

import {
    FREE_FROM_PROMOTION_FIELD,
    FREE_PRODUCT_ACTION_CODE,
    freeQuantityOf,
    variantIdsFromArgValue,
} from './free-product-action';
import { PRODUCTS_PERCENTAGE_DISCOUNT_CODE } from './products-percentage-discount-action';

/**
 * The line a promotion adds for its own products, kept in one place for the
 * storefronts' addFreeProductToOrder and for draft orders, where applying the
 * coupon adds them (see addCouponProductsToDraftOrder).
 */

/** Id of the promotion whose product [line] is, as tagged, or null for an ordinary line. */
export function freeFromPromotionOf(line: OrderLine): string | null {
    const tag = (line.customFields as Record<string, unknown> | undefined)?.[FREE_FROM_PROMOTION_FIELD];
    return tag == null || tag === '' ? null : String(tag);
}

/** [order]'s lines tagged for [promotion]: the ones a coupon added for its own products. */
function taggedLinesOf(order: Pick<Order, 'lines'> | undefined, promotion: Pick<Promotion, 'id'> | ID): OrderLine[] {
    const promotionId = String(typeof promotion === 'object' ? promotion.id : promotion);
    return (order?.lines ?? []).filter(l => freeFromPromotionOf(l) === promotionId);
}

/** The stored productVariantIds of [promotion]'s actions that price only their own tagged line. */
export function taggedLineVariantIds(promotion: Promotion): string[] {
    // Listed here, not at module level: the two action files import this one.
    const codes = [FREE_PRODUCT_ACTION_CODE, PRODUCTS_PERCENTAGE_DISCOUNT_CODE];
    return (promotion.actions ?? [])
        .filter(a => codes.includes(a.code))
        .flatMap(a => variantIdsFromArgValue(a.args.find(x => x.name === 'productVariantIds')?.value));
}

/**
 * Units of [productVariantId] that [promotion] prices on its own line: the sum
 * over its free_product and products_percentage_discount actions of how often
 * the variant is listed.
 */
export function couponUnitsOf(promotion: Promotion, productVariantId: ID): number {
    return freeQuantityOf(taggedLineVariantIds(promotion), productVariantId);
}

/** Units of [productVariantId] already on [order]'s lines tagged for [promotion]. */
function taggedUnitsOf(order: Pick<Order, 'lines'> | undefined, promotion: Promotion, productVariantId: ID): number {
    return taggedLinesOf(order, promotion)
        .filter(l => idsAreEqual(l.productVariantId, productVariantId))
        .reduce((sum, l) => sum + l.quantity, 0);
}

/**
 * Tops [promotion]'s tagged line of [productVariantId] in [orderId] up to the
 * units the promotion gives, never past them; [quantity], when given, can
 * only lower that. Returns the order unchanged when nothing is still due.
 */
export async function addCouponProductToOrder(
    ctx: RequestContext,
    orderService: OrderService,
    orderId: ID,
    promotion: Promotion,
    productVariantId: ID,
    quantity?: number | null,
) {
    // Read afresh: an order already in memory does not have the lines added
    // earlier in the same request.
    const order = await orderService.findOne(ctx, orderId);
    const remaining = couponUnitsOf(promotion, productVariantId) - taggedUnitsOf(order, promotion, productVariantId);
    if (remaining < 1) {
        return order;
    }
    return orderService.addItemToOrder(ctx, orderId, productVariantId, Math.min(quantity ?? remaining, remaining), {
        [FREE_FROM_PROMOTION_FIELD]: String(promotion.id),
    } as any);
}

let orderService: OrderService | undefined;

/** Called from each tagged-line action's init, for its onActivate and onDeactivate. */
export function rememberOrderService(injector: Injector) {
    orderService = injector.get(OrderService);
}

/**
 * onActivate of the tagged-line actions. A storefront adds the coupon's
 * products itself, through addFreeProductToOrder; in a draft order the admin
 * only applies the coupon, so its products are added here, each as its own
 * tagged line. Storefront orders are left as they are.
 */
export async function addCouponProductsToDraftOrder(ctx: RequestContext, order: Order, promotion: Promotion) {
    if (order.state !== 'Draft' || !orderService) {
        return;
    }
    for (const productVariantId of new Set(taggedLineVariantIds(promotion))) {
        // A product the order cannot take (not sold in this channel, say)
        // comes back as an error result; the coupon still applies.
        await addCouponProductToOrder(ctx, orderService, order.id, promotion, productVariantId);
    }
}

/**
 * onDeactivate of the tagged-line actions: takes a draft order's lines for
 * [promotion] out again, when the coupon is removed or no longer applies.
 */
export async function removeCouponProductsFromDraftOrder(ctx: RequestContext, order: Order, promotion: Promotion) {
    if (order.state !== 'Draft' || !orderService) {
        return;
    }
    const tagged = taggedLinesOf(order, promotion);
    if (!tagged.length) {
        return;
    }
    await orderService.removeItemsFromOrder(
        ctx,
        order.id,
        tagged.map(l => l.id),
    );
    // Off the order in memory too: each of the promotion's tagged-line actions
    // runs this on the same order, and a second would remove them again and
    // fail on lines that are already gone.
    order.lines = order.lines.filter(l => !tagged.includes(l));
}

/**
 * The coupon and its products are one thing to the admin: taking the last of
 * a coupon's products off a draft order takes the coupon off too (and with
 * it, through onDeactivate, anything else it gave). Returns [order] as it
 * is when [promotionId]'s products are still on it, or when it is not a
 * draft, or when no coupon of that promotion is on it.
 */
export async function removeCouponWhoseProductsAreGone(
    ctx: RequestContext,
    services: { orderService: OrderService; promotionService: PromotionService },
    order: Order,
    promotionId: string,
): Promise<Order> {
    if (order.state !== 'Draft' || hasCouponUnits(order, promotionId)) {
        return order;
    }
    const promotion = await services.promotionService.findOne(ctx, promotionId);
    if (!promotion?.couponCode || !order.couponCodes.includes(promotion.couponCode)) {
        return order;
    }
    return services.orderService.removeCouponCode(ctx, order.id, promotion.couponCode);
}

/** Whether any line tagged for [promotionId] still carries units. */
function hasCouponUnits(order: Pick<Order, 'lines'>, promotionId: string): boolean {
    return taggedLinesOf(order, promotionId).some(l => l.quantity > 0);
}

/**
 * The same, for "Modify order": [input] without the coupon of every one of
 * [promotions] whose product lines the admin's own rows all take to zero.
 * [promotions] is every promotion the coupon list could name: those applied
 * to the order and those active in the channel. Returned as given when no
 * coupon is dropped. The dry run that follows then sees the coupon gone, as
 * a coupon removed by hand would be.
 */
export function withCouponsOfRemovedProductsDropped(
    input: ModifyOrderInput,
    order: Pick<Order, 'lines' | 'couponCodes'>,
    promotions: Promotion[],
): ModifyOrderInput {
    const zeroed = (line: OrderLine) =>
        (input.adjustOrderLines ?? []).some(a => idsAreEqual(a.orderLineId, line.id) && a.quantity === 0);
    const couponsAfter = input.couponCodes ?? order.couponCodes;
    const dropped = promotions
        .filter(p => p.couponCode && couponsAfter.includes(p.couponCode))
        .filter(p => {
            const units = taggedLinesOf(order, p).filter(l => l.quantity > 0);
            return units.length > 0 && units.every(zeroed);
        })
        .map(p => p.couponCode as string);
    if (!dropped.length) {
        return input;
    }
    return { ...input, couponCodes: couponsAfter.filter(code => !dropped.includes(code)) };
}

/**
 * "Modify order" (a placed order) keeps its own ledger of changed lines, so
 * its coupon products go in through its own add-items and adjust-lines rows
 * rather than the draft hooks above. Returns [input] with those rows, on the
 * same activation rule as the hooks: a promotion in [appliedAfter] (what
 * applies once the modification is made) but not in [appliedBefore] (what
 * applied to [order] as it stands) gets the units it still owes, tagged; a
 * promotion in [appliedBefore] but not [appliedAfter] has its tagged lines
 * zeroed. A promotion in both is left as it is, so a storefront order keeps
 * the units the customer chose to take. A tagged line the admin's own input
 * adjusts is left to that row.
 */
export function withCouponProductChanges(
    input: ModifyOrderInput,
    order: Pick<Order, 'lines'>,
    appliedBefore: Promotion[],
    appliedAfter: Promotion[],
): ModifyOrderInput {
    const addItems = [...(input.addItems ?? [])];
    const adjustOrderLines = [...(input.adjustOrderLines ?? [])];
    const adjustedByAdmin = (line: OrderLine) => adjustOrderLines.some(a => idsAreEqual(a.orderLineId, line.id));
    const has = (list: Promotion[], promotion: Promotion) => list.some(p => idsAreEqual(p.id, promotion.id));

    for (const promotion of appliedAfter.filter(p => !has(appliedBefore, p))) {
        for (const productVariantId of new Set(taggedLineVariantIds(promotion))) {
            const tagged = taggedLinesOf(order, promotion);
            if (tagged.some(l => idsAreEqual(l.productVariantId, productVariantId) && adjustedByAdmin(l))) {
                continue;
            }
            const remaining =
                couponUnitsOf(promotion, productVariantId) - taggedUnitsOf(order, promotion, productVariantId);
            if (remaining >= 1) {
                // The tag is an internal custom field: not in the GraphQL input
                // type, but carried through to the order line like this.
                addItems.push({
                    productVariantId,
                    quantity: remaining,
                    customFields: { [FREE_FROM_PROMOTION_FIELD]: String(promotion.id) },
                } as AddItemInput);
            }
        }
    }
    for (const promotion of appliedBefore.filter(p => !has(appliedAfter, p))) {
        for (const line of taggedLinesOf(order, promotion)) {
            if (line.quantity > 0 && !adjustedByAdmin(line)) {
                adjustOrderLines.push({ orderLineId: line.id, quantity: 0 });
            }
        }
    }
    return { ...input, addItems, adjustOrderLines };
}
