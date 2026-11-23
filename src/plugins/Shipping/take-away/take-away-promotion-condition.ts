import { Injector, LanguageCode, PromotionCondition, TransactionalConnection } from '@vendure/core';

import { findPickupMethods } from './take-away-method';

let connection: TransactionalConnection;

/**
 * Take Away (store pickup) condition. Binding uses the promotion's own
 * standard **Coupon code** field — no extra inputs on the condition: the
 * promotion applies only when the selected method is a pickup method whose
 * "Take Away Coupon Code" custom field equals the promotion's coupon code.
 * A method with an empty Take Away Coupon Code gets no discount.
 *
 * The customer never types the code: TakeAwayShopResolver auto-applies the
 * method's coupon when the method is selected (and removes it on switch), so
 * from the customer's perspective the discount is automatic.
 *
 * Promotions using this condition are hidden from the customer coupon list
 * (see PromotionCodesPlugin.getCouponCodeList).
 */
export const takeAwaySelectedCondition = new PromotionCondition({
    code: 'take_away_shipping_selected',
    description: [
        { languageCode: LanguageCode.en, value: 'Take Away (store pickup) shipping method is selected' },
    ],
    args: {},
    init: (injector: Injector) => {
        connection = injector.get(TransactionalConnection);
    },
    check: async (ctx, order, args, promotion) => {
        // Binding comes from the promotion's own coupon code; without one the
        // promotion can never apply.
        if (!promotion.couponCode) {
            return false;
        }
        const methods = await findPickupMethods(ctx, connection, order);
        // Strict binding: the method must carry a non-empty Take Away
        // Coupon Code equal to the promotion's coupon code. An empty
        // field on the method means "no discount for this method".
        return methods.some(method => {
            const methodCoupon = (method.customFields as any)?.takeAwayCouponCode;
            return !!methodCoupon && methodCoupon === promotion.couponCode;
        });
    },
});
