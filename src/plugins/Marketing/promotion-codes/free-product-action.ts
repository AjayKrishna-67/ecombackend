import { ConfigService, EntityIdStrategy, ID, idsAreEqual, Injector, LanguageCode, PromotionLineAction } from '@vendure/core';

import {
    addCouponProductsToDraftOrder,
    rememberOrderService,
    removeCouponProductsFromDraftOrder,
} from './coupon-product-lines';

export const FREE_PRODUCT_ACTION_CODE = 'free_product';

/**
 * How many units of a variant the promotion gives away: one per time the
 * variant appears in the action's `productVariantIds`. The admin editor's
 * count box writes the id that many times, so "2 x Onion" is stored as
 * ["1278","1278"]. Promotions saved before quantities existed list each id
 * once and keep giving one unit.
 */
export function freeQuantityOf(productVariantIds: readonly ID[] | null | undefined, variantId: ID): number {
    return (productVariantIds ?? []).filter(id => idsAreEqual(id, variantId)).length;
}

/** The ids in the raw JSON the promotion stores the arg as, repeats kept. */
export function variantIdsFromArgValue(argValue: string | null | undefined): string[] {
    try {
        const parsed = argValue ? JSON.parse(argValue) : [];
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
}

/** Same count, from the raw JSON the promotion stores the arg as. */
export function freeQuantityFromArgValue(argValue: string | null | undefined, variantId: ID): number {
    return freeQuantityOf(variantIdsFromArgValue(argValue), variantId);
}

/**
 * OrderLine custom field the storefront sets, to the promotion id, on the line
 * it adds for a promotion's free product. Because custom fields take part in
 * line merging, that line stays separate from any line the customer added for
 * the same product, and only that line is made free.
 */
export const FREE_FROM_PROMOTION_FIELD = 'freeFromPromotion';

/**
 * Makes the selected product variants free, as many units of each as the
 * admin set, on the line the storefront added for this promotion.
 *
 * Exists because neither core action can express "this product is free":
 *
 * - `order_fixed_discount` takes a hand-typed amount. The free product is priced
 *   per channel, so one amount cannot match every channel: a customer pays the
 *   difference where the product costs more, and is over-discounted where it
 *   costs less. It is also spread across every line, so the free product never
 *   shows as free on the order.
 * - Vendure core's `products_percentage_discount` at 100% freed every unit in
 *   the line, so raising the quantity in the cart gave away unlimited stock.
 *   (That code is now this plugin's coupon-unit version, see
 *   products-percentage-discount-action.ts.)
 *
 * This action is pricing only. It does not add the product to the order: the
 * storefronts read this action's `productVariantIds` and add each product as
 * its own line, tagged with `freeFromPromotion = <promotion id>`, when the
 * coupon is applied. A line without that tag, such as the same product the
 * customer put in the cart themselves, is charged in full.
 */
/**
 * Decodes the tag the storefront wrote. Storefronts only ever see API ids,
 * which the configured EntityIdStrategy may encode (the e2e server uses
 * "T_1"); the promotion passed to execute carries the database id.
 */
let entityIdStrategy: EntityIdStrategy<any> | undefined;

/** Reads the configured id strategy; called from each tag-reading action's init. */
export function rememberEntityIdStrategy(injector: Injector) {
    const config = injector.get(ConfigService);
    // entityOptions.entityIdStrategy is where it lives now; the top-level
    // one is the deprecated spelling, kept as a fallback.
    entityIdStrategy = config.entityOptions?.entityIdStrategy ?? config.entityIdStrategy;
}

/**
 * Whether [orderLine] is the line a storefront added for [promotionId]'s
 * product (its freeFromPromotion tag names that promotion). The customer's
 * own line of the same product has no tag.
 */
export function isLineTaggedFor(orderLine: { customFields?: unknown }, promotionId: ID): boolean {
    const tag = (orderLine.customFields as Record<string, unknown> | undefined)?.[FREE_FROM_PROMOTION_FIELD];
    if (tag == null || tag === '') {
        return false;
    }
    const taggedPromotionId = entityIdStrategy ? entityIdStrategy.decodeId(String(tag)) : String(tag);
    return idsAreEqual(taggedPromotionId, promotionId);
}

export const freeProductAction = new PromotionLineAction({
    code: FREE_PRODUCT_ACTION_CODE,
    init(injector: Injector) {
        rememberEntityIdStrategy(injector);
        rememberOrderService(injector);
    },
    // In a draft order, applying the coupon adds the free products and
    // removing it takes them out (see coupon-product-lines.ts). Wrapped,
    // because that file imports this one.
    onActivate: (ctx, order, args, promotion) => addCouponProductsToDraftOrder(ctx, order, promotion),
    onDeactivate: (ctx, order, args, promotion) => removeCouponProductsFromDraftOrder(ctx, order, promotion),
    description: [
        { languageCode: LanguageCode.en, value: 'Make the specified products free' },
    ],
    args: {
        productVariantIds: {
            type: 'ID',
            list: true,
            // Product search plus a count box per product; the count is
            // stored by repeating the id (see freeQuantityOf).
            ui: { component: 'free-product-quantity-input' },
            label: [{ languageCode: LanguageCode.en, value: 'Free products and quantities' }],
        },
    },
    execute(ctx, orderLine, args, state, promotion) {
        const variantId = orderLine.productVariant?.id ?? orderLine.productVariantId;
        const freeUnits = freeQuantityOf(args.productVariantIds, variantId);
        if (freeUnits < 1 || orderLine.quantity < 1) {
            return 0;
        }
        if (!isLineTaggedFor(orderLine, promotion.id)) {
            return 0;
        }
        // Adjustment amounts are read in the same tax basis as the line's list
        // price. The prorated price is what is still payable after any earlier
        // promotion on this line, so the unit lands on exactly zero.
        const payableUnitPrice = orderLine.listPriceIncludesTax
            ? orderLine.proratedUnitPriceWithTax
            : orderLine.proratedUnitPrice;
        return -payableUnitPrice * Math.min(freeUnits, orderLine.quantity);
    },
});
