import { AdjustmentType } from '@vendure/common/lib/generated-types';
import { OrderLine } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import {
    FREE_FROM_PROMOTION_FIELD,
    FREE_PRODUCT_ACTION_CODE,
    freeProductAction,
    freeQuantityFromArgValue,
    freeQuantityOf,
} from './free-product-action';

const ONION_VARIANT_ID = 1278;
const PROMOTION_ID = 149;
const ctx = {} as any;
const promotion = { id: PROMOTION_ID } as any;

// The action receives its args the way Vendure stores them: name/value strings.
const argsFor = (variantIds: number[]) => [
    { name: 'productVariantIds', value: JSON.stringify(variantIds.map(String)) },
];

// A real OrderLine, so the price getters under test are Vendure's own.
// By default the line is the one the storefront added for this promotion.
const lineOf = (input: {
    variantId: number;
    listPrice: number;
    quantity: number;
    listPriceIncludesTax?: boolean;
    taxRate?: number;
    freeFromPromotion?: number | string | null;
}) =>
    new OrderLine({
        productVariantId: input.variantId,
        listPrice: input.listPrice,
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

const execute = (line: OrderLine, variantIds = [ONION_VARIANT_ID]) =>
    freeProductAction.execute(ctx, line, argsFor(variantIds), {}, promotion);

describe('freeProductAction', () => {
    it('is registered under the code the coupon list looks for', () => {
        expect(freeProductAction.code).toBe(FREE_PRODUCT_ACTION_CODE);
        expect(FREE_PRODUCT_ACTION_CODE).toBe('free_product');
    });

    it('discounts the product by its own price, whatever that price is', async () => {
        // Idukki sells the free onion at 28.00 while the old fixed discount was
        // 25.00, which left the customer paying 3.00 for a "free" product.
        const inputLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2800, quantity: 1 });

        const actualDiscount = await execute(inputLine);

        expect(actualDiscount).toBe(-2800);
    });

    it('frees as many units as the product is listed', async () => {
        // The admin's count box of 2 is stored as the id listed twice.
        const inputLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 3 });

        const actualDiscount = await execute(inputLine, [ONION_VARIANT_ID, ONION_VARIANT_ID]);

        expect(actualDiscount).toBe(-5000);
    });

    it('never frees more units than the line holds', async () => {
        const inputLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1 });

        const actualDiscount = await execute(inputLine, [ONION_VARIANT_ID, ONION_VARIANT_ID, ONION_VARIANT_ID]);

        expect(actualDiscount).toBe(-2500);
    });

    it('frees only one unit when the product is listed once and the line holds several', async () => {
        const inputLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 3 });

        const actualDiscount = await execute(inputLine);

        expect(actualDiscount).toBe(-2500);
    });

    it('leaves other products untouched', async () => {
        const inputLine = lineOf({ variantId: 999, listPrice: 70000, quantity: 1 });

        const actualDiscount = await execute(inputLine);

        expect(actualDiscount).toBe(0);
    });

    it('frees one unit of each selected product', async () => {
        const inputLine = lineOf({ variantId: 1681, listPrice: 2800, quantity: 1 });

        const actualDiscount = await execute(inputLine, [ONION_VARIANT_ID, 1681]);

        expect(actualDiscount).toBe(-2800);
    });

    it('gives nothing for a line with no quantity', async () => {
        const inputLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 0 });

        const actualDiscount = await execute(inputLine);

        expect(actualDiscount).toBe(0);
    });

    it('works in the tax basis of the list price when prices exclude tax', async () => {
        // Adjustments on a tax-exclusive line are read as tax-exclusive, so the
        // discount must be the net price, not the gross 2625.
        const inputLine = lineOf({
            variantId: ONION_VARIANT_ID,
            listPrice: 2500,
            quantity: 1,
            listPriceIncludesTax: false,
            taxRate: 5,
        });

        const actualDiscount = await execute(inputLine);

        expect(actualDiscount).toBe(-2500);
    });

    it('discounts only what is still payable after an earlier promotion', async () => {
        const inputLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1 });
        inputLine.addAdjustment({
            amount: -500,
            type: AdjustmentType.PROMOTION,
            description: 'earlier promotion',
            adjustmentSource: 'PROMOTION:1',
            data: {},
        });

        const actualDiscount = await execute(inputLine);

        expect(actualDiscount).toBe(-2000);
    });

    it("charges the customer's own line of the same product in full", async () => {
        // Same product, but the customer added it: no promotion tag.
        const ownLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 2, freeFromPromotion: null });

        expect(await execute(ownLine)).toBe(0);
    });

    it('leaves a line that another promotion added alone', async () => {
        const otherPromotionLine = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1, freeFromPromotion: 148 });

        expect(await execute(otherPromotionLine)).toBe(0);
    });

    it('accepts the tag as a number or a string', async () => {
        const asNumber = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1, freeFromPromotion: PROMOTION_ID });
        const asString = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1, freeFromPromotion: String(PROMOTION_ID) });

        expect(await execute(asNumber)).toBe(-2500);
        expect(await execute(asString)).toBe(-2500);
    });

    it('decodes an encoded API id in the tag through the configured id strategy', async () => {
        // The storefront stores what the API gave it ("T_149" under an encoding
        // strategy); the action must compare that with the database id.
        const injector = {
            get: () => ({
                entityOptions: { entityIdStrategy: { decodeId: (id: string) => Number(id.replace('T_', '')) } },
            }),
        } as any;
        await freeProductAction.init(injector);
        try {
            const encodedTag = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1, freeFromPromotion: 'T_149' });
            const otherEncoded = lineOf({ variantId: ONION_VARIANT_ID, listPrice: 2500, quantity: 1, freeFromPromotion: 'T_148' });

            expect(await execute(encodedTag)).toBe(-2500);
            expect(await execute(otherEncoded)).toBe(0);
        } finally {
            await freeProductAction.init({ get: () => ({ entityOptions: {} }) } as any);
        }
    });
});

describe('freeQuantityOf', () => {
    it('counts how often a variant is listed', () => {
        expect(freeQuantityOf(['1278', '1278', '99'], 1278)).toBe(2);
        expect(freeQuantityOf(['1278'], '1278')).toBe(1);
        expect(freeQuantityOf(['99'], 1278)).toBe(0);
        expect(freeQuantityOf(null, 1278)).toBe(0);
    });

    it('reads the stored JSON arg, and treats broken JSON as nothing', () => {
        expect(freeQuantityFromArgValue('["1278","1278"]', 1278)).toBe(2);
        expect(freeQuantityFromArgValue('not json', 1278)).toBe(0);
        expect(freeQuantityFromArgValue(undefined, 1278)).toBe(0);
    });
});
