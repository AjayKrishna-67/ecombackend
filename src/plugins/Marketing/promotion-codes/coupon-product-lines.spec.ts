import { ModifyOrderInput } from '@vendure/common/lib/generated-types';
import { Order, OrderLine, Promotion } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { withCouponProductChanges, withCouponsOfRemovedProductsDropped } from './coupon-product-lines';
import { FREE_FROM_PROMOTION_FIELD, FREE_PRODUCT_ACTION_CODE } from './free-product-action';

const ONION = 1278;
const JUICE = 14;

/** A promotion giving [units] onions, stored the way Vendure stores actions. */
const onionPromotion = (id: number, units: number, couponCode?: string) =>
    new Promotion({
        id,
        couponCode,
        actions: [
            {
                code: FREE_PRODUCT_ACTION_CODE,
                args: [{ name: 'productVariantIds', value: JSON.stringify(Array(units).fill(String(ONION))) }],
            },
        ],
    });

const line = (id: number, variantId: number, quantity: number, freeFromPromotion?: number) =>
    new OrderLine({
        id,
        productVariantId: variantId,
        quantity,
        customFields: freeFromPromotion == null ? {} : { [FREE_FROM_PROMOTION_FIELD]: String(freeFromPromotion) },
    });

const orderOf = (...lines: OrderLine[]) => new Order({ id: 1, couponCodes: [], lines });
const orderWithCoupon = (couponCode: string, ...lines: OrderLine[]) =>
    new Order({ id: 1, couponCodes: [couponCode], lines });
const input = (extra: Partial<ModifyOrderInput> = {}): ModifyOrderInput => ({ orderId: 1, dryRun: false, ...extra });
const onionRow = (promotionId: number, quantity: number) => ({
    productVariantId: String(ONION),
    quantity,
    customFields: { [FREE_FROM_PROMOTION_FIELD]: String(promotionId) },
});

describe('withCouponProductChanges', () => {
    it('adds the units a newly applying coupon owes, tagged with the promotion', () => {
        const promotion = onionPromotion(72, 2);
        const result = withCouponProductChanges(input(), orderOf(line(1, JUICE, 1)), [], [promotion]);

        // The id as the promotion stores it.
        expect(result.addItems).toEqual([onionRow(72, 2)]);
        expect(result.adjustOrderLines).toEqual([]);
    });

    it('adds only the units not yet on a tagged line', () => {
        const promotion = onionPromotion(72, 2);
        const order = orderOf(line(1, JUICE, 1), line(2, ONION, 1, 72));

        expect(withCouponProductChanges(input(), order, [], [promotion]).addItems).toEqual([onionRow(72, 1)]);
    });

    it('leaves a coupon that was already applied alone, whatever units the customer took', () => {
        const promotion = onionPromotion(72, 2);
        const order = orderOf(line(1, JUICE, 1), line(2, ONION, 1, 72));
        const result = withCouponProductChanges(input(), order, [promotion], [promotion]);

        expect(result.addItems).toEqual([]);
        expect(result.adjustOrderLines).toEqual([]);
    });

    it('zeroes the tagged lines of a coupon that stops applying', () => {
        const promotion = onionPromotion(72, 2);
        const order = orderOf(line(1, JUICE, 1), line(2, ONION, 2, 72));

        expect(withCouponProductChanges(input(), order, [promotion], []).adjustOrderLines).toEqual([
            { orderLineId: 2, quantity: 0 },
        ]);
    });

    it('leaves a tagged line of a promotion that was never applied through this order', () => {
        // Tagged by a promotion that applied at placement and has since been
        // disabled: it is in neither list, and the line is the customer's.
        const order = orderOf(line(1, JUICE, 1), line(2, ONION, 2, 72));

        expect(withCouponProductChanges(input(), order, [], []).adjustOrderLines).toEqual([]);
    });

    it("leaves a tagged line the admin's own input adjusts, when adding and when removing", () => {
        const promotion = onionPromotion(72, 2);
        const adjusting = input({ adjustOrderLines: [{ orderLineId: 2, quantity: 1 }] });

        // Re-raised from nothing by the admin while the coupon starts applying.
        const emptied = orderOf(line(1, JUICE, 1), line(2, ONION, 0, 72));
        expect(withCouponProductChanges(adjusting, emptied, [], [promotion]).addItems).toEqual([]);
        // Lowered by the admin while the coupon stops applying: not zeroed on top.
        const carrying = orderOf(line(1, JUICE, 1), line(2, ONION, 2, 72));
        expect(withCouponProductChanges(adjusting, carrying, [promotion], []).adjustOrderLines).toEqual([
            { orderLineId: 2, quantity: 1 },
        ]);
    });

    it('is the same for an order modification whose only change is the coupon list', () => {
        const promotion = onionPromotion(72, 2);
        const result = withCouponProductChanges(input({ couponCodes: [] }), orderOf(line(1, JUICE, 1), line(2, ONION, 2, 72)), [promotion], []);

        expect(result.couponCodes).toEqual([]);
        expect(result.adjustOrderLines).toEqual([{ orderLineId: 2, quantity: 0 }]);
    });

    it("keeps the admin's own rows and the rest of the input", () => {
        const promotion = onionPromotion(72, 1);
        const result = withCouponProductChanges(
            input({ dryRun: true, couponCodes: ['ONION649'], addItems: [{ productVariantId: JUICE, quantity: 1 }] }),
            orderOf(line(1, JUICE, 1)),
            [],
            [promotion],
        );

        expect(result.dryRun).toBe(true);
        expect(result.couponCodes).toEqual(['ONION649']);
        expect(result.addItems).toEqual([{ productVariantId: JUICE, quantity: 1 }, onionRow(72, 1)]);
    });
});

describe('withCouponsOfRemovedProductsDropped', () => {
    const promotion = onionPromotion(72, 2, 'ONION649');
    const juiceAndOnion = () => orderWithCoupon('ONION649', line(1, JUICE, 1), line(2, ONION, 2, 72));

    it("drops the coupon whose every product line the admin's rows zero", () => {
        const result = withCouponsOfRemovedProductsDropped(
            input({ couponCodes: ['ONION649'], adjustOrderLines: [{ orderLineId: 2, quantity: 0 }] }),
            juiceAndOnion(),
            [promotion],
        );

        expect(result.couponCodes).toEqual([]);
        expect(result.adjustOrderLines).toEqual([{ orderLineId: 2, quantity: 0 }]);
    });

    it('reads the coupon list off the order when the input does not carry one', () => {
        const result = withCouponsOfRemovedProductsDropped(
            input({ adjustOrderLines: [{ orderLineId: 2, quantity: 0 }] }),
            juiceAndOnion(),
            [promotion],
        );

        expect(result.couponCodes).toEqual([]);
    });

    it('drops a coupon still on the order even when its promotion is not applied at the moment', () => {
        const stale = orderWithCoupon('ONION649', line(1, JUICE, 1), line(2, ONION, 2, 72));
        // The promotion comes in through the channel's active list, not the order's.
        const result = withCouponsOfRemovedProductsDropped(
            input({ adjustOrderLines: [{ orderLineId: 2, quantity: 0 }] }),
            stale,
            [promotion],
        );

        expect(result.couponCodes).toEqual([]);
    });

    it('keeps the coupon while one of its product lines keeps units', () => {
        const order = orderWithCoupon('ONION649', line(1, JUICE, 1), line(2, ONION, 1, 72), line(3, ONION, 1, 72));
        const result = withCouponsOfRemovedProductsDropped(
            input({ adjustOrderLines: [{ orderLineId: 2, quantity: 0 }] }),
            order,
            [promotion],
        );

        expect(result.couponCodes).toBeUndefined();
    });

    it('keeps the coupon when a product line is only lowered', () => {
        const result = withCouponsOfRemovedProductsDropped(
            input({ adjustOrderLines: [{ orderLineId: 2, quantity: 1 }] }),
            juiceAndOnion(),
            [promotion],
        );

        expect(result.couponCodes).toBeUndefined();
    });

    it("leaves the input alone when the admin's rows touch no coupon line", () => {
        const original = input({ couponCodes: ['ONION649'], adjustOrderLines: [{ orderLineId: 1, quantity: 0 }] });

        expect(withCouponsOfRemovedProductsDropped(original, juiceAndOnion(), [promotion])).toBe(original);
    });
});
