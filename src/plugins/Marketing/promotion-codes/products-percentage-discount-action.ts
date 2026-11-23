import { Injector, LanguageCode, PromotionLineAction } from '@vendure/core';

import {
    addCouponProductsToDraftOrder,
    rememberOrderService,
    removeCouponProductsFromDraftOrder,
} from './coupon-product-lines';
import { freeQuantityOf, isLineTaggedFor, rememberEntityIdStrategy } from './free-product-action';

/** Vendure core's code for "Discount specified products by %", taken over here. */
export const PRODUCTS_PERCENTAGE_DISCOUNT_CODE = 'products_percentage_discount';

/**
 * "Discount specified products by %", reworked to take the percentage off the
 * coupon's own unit of the selected products, the way free_product makes it
 * free: only on the line the storefront added for this promotion (tagged
 * `freeFromPromotion = <promotion id>`), and only as many units as the admin
 * set (one per time the product is listed; a product listed once is one unit).
 *
 * It replaces Vendure core's action of the same code (see the plugin's
 * configuration). Core's discounts every unit of every line of the product:
 * raise the quantity to 5 and the coupon takes 10% off all 5, and a unit the
 * customer adds from a collection merges into the discounted line. Here the
 * coupon's unit is its own line, the discount stays fixed whatever the
 * customer adds, and the customer's own units are charged in full. Same code,
 * name and argument names as core, so promotions saved with core's action
 * keep their percentage and products and work unchanged in the admin.
 *
 * Pricing only, like free_product: the storefronts read `productVariantIds`
 * and add each product as its own tagged line through addFreeProductToOrder
 * when the coupon is applied.
 */
export const productsPercentageDiscountAction = new PromotionLineAction({
    code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
    init(injector: Injector) {
        rememberEntityIdStrategy(injector);
        rememberOrderService(injector);
    },
    // Draft orders: same as free_product (see coupon-product-lines.ts).
    onActivate: (ctx, order, args, promotion) => addCouponProductsToDraftOrder(ctx, order, promotion),
    onDeactivate: (ctx, order, args, promotion) => removeCouponProductsFromDraftOrder(ctx, order, promotion),
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'Discount specified products by { discount }%',
        },
    ],
    args: {
        discount: {
            type: 'float',
            ui: { component: 'number-form-input', suffix: '%', min: 0, max: 100 },
            label: [{ languageCode: LanguageCode.en, value: 'Discount' }],
        },
        productVariantIds: {
            type: 'ID',
            list: true,
            // Same product search and per-product count box as free_product;
            // the count is stored by repeating the id (see freeQuantityOf).
            ui: { component: 'free-product-quantity-input' },
            label: [{ languageCode: LanguageCode.en, value: 'Product variants and discounted units' }],
        },
    },
    execute(ctx, orderLine, args, state, promotion) {
        const variantId = orderLine.productVariant?.id ?? orderLine.productVariantId;
        const units = Math.min(freeQuantityOf(args.productVariantIds, variantId), orderLine.quantity);
        const percent = Math.min(Math.max(Number(args.discount) || 0, 0), 100);
        if (units < 1 || percent <= 0) {
            return 0;
        }
        if (!isLineTaggedFor(orderLine, promotion.id)) {
            return 0;
        }
        // Same tax basis and payable price as free_product, so 100% lands on
        // exactly zero and an earlier promotion is never discounted twice.
        const payableUnitPrice = orderLine.listPriceIncludesTax
            ? orderLine.proratedUnitPriceWithTax
            : orderLine.proratedUnitPrice;
        return -Math.round((payableUnitPrice * units * percent) / 100);
    },
});
