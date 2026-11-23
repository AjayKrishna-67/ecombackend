import { OrderLine } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import {
    PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
    productsPercentageDiscountAction,
} from './products-percentage-discount-action';
import { FREE_FROM_PROMOTION_FIELD } from './free-product-action';

// BREADNBOOST: 10% off The Internal Cooler 60ml (variant 1463, Rs.30).
const COOLER_VARIANT_ID = 1463;
const PROMOTION_ID = 132;
const ctx = {} as any;
const promotion = { id: PROMOTION_ID } as any;

const argsFor = (discount: number, variantIds: number[]) => [
    { name: 'discount', value: String(discount) },
    { name: 'productVariantIds', value: JSON.stringify(variantIds.map(String)) },
];

const lineOf = (input: {
    variantId?: number;
    listPrice?: number;
    quantity: number;
    listPriceIncludesTax?: boolean;
    taxRate?: number;
    freeFromPromotion?: number | string | null;
}) =>
    new OrderLine({
        productVariantId: input.variantId ?? COOLER_VARIANT_ID,
        listPrice: input.listPrice ?? 3000,
        listPriceIncludesTax: input.listPriceIncludesTax ?? true,
        quantity: input.quantity,
        orderPlacedQuantity: 0,
        adjustments: [],
        taxLines: [{ description: 'tax', taxRate: input.taxRate ?? 0 }],
        customFields: {
            [FREE_FROM_PROMOTION_FIELD]:
                input.freeFromPromotion === undefined ? String(PROMOTION_ID) : input.freeFromPromotion,
        } as any,
    });

const execute = (line: OrderLine, discount = 10, variantIds = [COOLER_VARIANT_ID]) =>
    productsPercentageDiscountAction.execute(ctx, line, argsFor(discount, variantIds), {}, promotion);

describe('productsPercentageDiscountAction', () => {
    it("takes over the core action's code and name, so existing coupons keep working", () => {
        expect(productsPercentageDiscountAction.code).toBe(PRODUCTS_PERCENTAGE_DISCOUNT_CODE);
        expect(PRODUCTS_PERCENTAGE_DISCOUNT_CODE).toBe('products_percentage_discount');
        const definition = productsPercentageDiscountAction.toGraphQlType({
            languageCode: 'en',
            channel: { defaultLanguageCode: 'en' },
        } as any);
        expect(definition.description).toBe('Discount specified products by { discount }%');
        expect(definition.args.map(a => a.name)).toEqual(['discount', 'productVariantIds']);
    });

    it('reads the product list the core action saved ("[1463]", numbers)', async () => {
        const coreArgs = [
            { name: 'discount', value: '10' },
            { name: 'productVariantIds', value: '[1463]' },
        ];
        const result = await productsPercentageDiscountAction.execute(
            ctx,
            lineOf({ quantity: 2 }),
            coreArgs,
            {},
            promotion,
        );
        expect(result).toBe(-300);
    });

    it("takes the percentage off the coupon's unit", async () => {
        expect(await execute(lineOf({ quantity: 1 }))).toBe(-300);
    });

    it('does not grow when the quantity is raised: only the coupon units are discounted', async () => {
        // The core products_percentage_discount would take 10% off all three.
        expect(await execute(lineOf({ quantity: 3 }))).toBe(-300);
    });

    it('discounts as many units as the product is listed', async () => {
        expect(await execute(lineOf({ quantity: 3 }), 10, [COOLER_VARIANT_ID, COOLER_VARIANT_ID])).toBe(-600);
    });

    it('at 100% makes the unit free', async () => {
        expect(await execute(lineOf({ quantity: 2 }), 100)).toBe(-3000);
    });

    it('never takes off more than the line still costs', async () => {
        expect(await execute(lineOf({ quantity: 1 }), 150)).toBe(-3000);
    });

    it("charges the customer's own line of the same product in full", async () => {
        expect(await execute(lineOf({ quantity: 2, freeFromPromotion: null }))).toBe(0);
    });

    it('leaves a line another promotion added alone', async () => {
        expect(await execute(lineOf({ quantity: 1, freeFromPromotion: 131 }))).toBe(0);
    });

    it('leaves other products and empty or zero discounts alone', async () => {
        expect(await execute(lineOf({ quantity: 1, variantId: 999 }))).toBe(0);
        expect(await execute(lineOf({ quantity: 1 }), 0)).toBe(0);
        expect(await execute(lineOf({ quantity: 0 }))).toBe(0);
    });

    it('works in the tax basis of the list price when prices exclude tax', async () => {
        const line = lineOf({ quantity: 1, listPrice: 2500, listPriceIncludesTax: false, taxRate: 5 });
        expect(await execute(line)).toBe(-250);
    });
});
