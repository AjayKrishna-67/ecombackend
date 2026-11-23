import { defaultPromotionConditions, mergeConfig } from '@vendure/core';
import {
    createTestEnvironment,
    registerInitializer,
    SqljsInitializer,
    testConfig,
} from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../plugins/Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { PromotionCodesPlugin } from '../../plugins/Marketing/promotion-codes/promotion-codes.plugin';
import { shouldApplyCouponcode } from '../shouldApply';

/**
 * End-to-end coverage for the "Coupon code should be applicable" condition.
 *
 * The condition is one line: it returns the promotion's `shouldApply` checkbox.
 * What needs proving is the wiring around it. The checkbox is a custom field
 * that PromotionCodesPlugin registers, the condition is registered separately
 * in vendure-config.ts, and the value reaches the condition only if Vendure
 * loads custom fields onto the Promotion it evaluates. The test mirrors that
 * registration and drives a real order through the Shop API.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(process.cwd(), 'src/customPromotionConditions/e2e/__data__');

registerInitializer('sqljs', new SqljsInitializer(dataDir));

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [PromotionCodesPlugin],
        // Registered the same way vendure-config.ts registers it.
        promotionOptions: {
            promotionConditions: [...defaultPromotionConditions, shouldApplyCouponcode],
        },
        apiOptions: { port: 3057 },
    }),
);

const COUPON_CODE = 'FLAG10';
const CARROT_PRICE = 10000;
const DISCOUNT_PERCENT = 10;

const CREATE_PRODUCT = gql`
    mutation CreateProduct($input: CreateProductInput!) {
        createProduct(input: $input) {
            id
        }
    }
`;

const CREATE_VARIANTS = gql`
    mutation CreateVariants($input: [CreateProductVariantInput!]!) {
        createProductVariants(input: $input) {
            id
        }
    }
`;

const CREATE_PROMOTION = gql`
    mutation CreatePromotion($input: CreatePromotionInput!) {
        createPromotion(input: $input) {
            ... on Promotion {
                id
                conditions {
                    code
                }
                customFields {
                    shouldApply
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const UPDATE_PROMOTION = gql`
    mutation UpdatePromotion($input: UpdatePromotionInput!) {
        updatePromotion(input: $input) {
            ... on Promotion {
                id
                customFields {
                    shouldApply
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const ORDER_FRAGMENT = gql`
    fragment FlagOrder on Order {
        id
        couponCodes
        subTotalWithTax
        discounts {
            description
            amountWithTax
        }
        lines {
            id
            quantity
        }
    }
`;

const ADD_ITEM = gql`
    mutation AddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ...FlagOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;

const ADJUST_LINE = gql`
    mutation AdjustLine($orderLineId: ID!, $quantity: Int!) {
        adjustOrderLine(orderLineId: $orderLineId, quantity: $quantity) {
            ...FlagOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;

const APPLY_COUPON = gql`
    mutation ApplyCoupon($couponCode: String!) {
        applyCouponCode(couponCode: $couponCode) {
            ...FlagOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;

interface FlagOrder {
    id: string;
    couponCodes: string[];
    subTotalWithTax: number;
    discounts: Array<{ description: string; amountWithTax: number }>;
    lines: Array<{ id: string; quantity: number }>;
}

describe('"Coupon code should be applicable" condition (e2e)', () => {
    let carrotVariantId: string;
    let promotionId: string;
    let orderLineId: string;

    const setCheckbox = async (shouldApply: boolean) => {
        const result = await adminClient.query(UPDATE_PROMOTION, {
            input: { id: promotionId, customFields: { shouldApply } },
        });
        expect(result.updatePromotion.message).toBeUndefined();
        expect(result.updatePromotion.customFields.shouldApply).toBe(shouldApply);
    };

    // Promotions are only re-evaluated when the order changes, so nudge the
    // line quantity to force a recalculation after the checkbox is changed.
    const recalculatedOrder = async (): Promise<FlagOrder> => {
        const result = await shopClient.query(ADJUST_LINE, { orderLineId, quantity: 2 });
        expect(result.adjustOrderLine.message).toBeUndefined();
        return result.adjustOrderLine;
    };

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();

        const productResult = await adminClient.query(CREATE_PRODUCT, {
            input: {
                translations: [
                    { languageCode: 'en', name: 'Carrot 1kg', slug: 'carrot', description: 'Carrot' },
                ],
            },
        });
        const variantResult = await adminClient.query(CREATE_VARIANTS, {
            input: [
                {
                    productId: productResult.createProduct.id,
                    sku: 'CARROT',
                    price: CARROT_PRICE,
                    trackInventory: 'FALSE',
                    translations: [{ languageCode: 'en', name: 'Carrot 1kg' }],
                },
            ],
        });
        carrotVariantId = variantResult.createProductVariants[0].id;
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('is accepted on a promotion together with the checkbox', async () => {
        const actualResult = await adminClient.query(CREATE_PROMOTION, {
            input: {
                enabled: true,
                couponCode: COUPON_CODE,
                translations: [{ languageCode: 'en', name: COUPON_CODE }],
                conditions: [{ code: shouldApplyCouponcode.code, arguments: [] }],
                actions: [
                    {
                        code: 'order_percentage_discount',
                        arguments: [{ name: 'discount', value: String(DISCOUNT_PERCENT) }],
                    },
                ],
                customFields: { shouldApply: false },
            },
        });

        expect(actualResult.createPromotion.message).toBeUndefined();
        expect(actualResult.createPromotion.conditions).toEqual([{ code: 'shouldApplyCouponcode' }]);
        expect(actualResult.createPromotion.customFields.shouldApply).toBe(false);
        promotionId = actualResult.createPromotion.id;
    });

    it('accepts the coupon but gives no discount while the checkbox is unticked', async () => {
        const addResult = await shopClient.query(ADD_ITEM, {
            productVariantId: carrotVariantId,
            quantity: 1,
        });
        orderLineId = addResult.addItemToOrder.lines[0].id;

        const actualResult = await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE });

        const actualOrder: FlagOrder = actualResult.applyCouponCode;
        expect(actualOrder.couponCodes).toEqual([COUPON_CODE]);
        expect(actualOrder.discounts).toEqual([]);
        expect(actualOrder.subTotalWithTax).toBe(CARROT_PRICE);
    });

    it('gives the discount once the checkbox is ticked', async () => {
        await setCheckbox(true);

        const actualOrder = await recalculatedOrder();

        const expectedSubTotal = 2 * CARROT_PRICE;
        expect(actualOrder.discounts).toHaveLength(1);
        expect(actualOrder.discounts[0].amountWithTax).toBe(-(expectedSubTotal * DISCOUNT_PERCENT) / 100);
        expect(actualOrder.subTotalWithTax).toBe(expectedSubTotal - (expectedSubTotal * DISCOUNT_PERCENT) / 100);
    });

    it('withdraws the discount again when the checkbox is unticked', async () => {
        await setCheckbox(false);

        const actualOrder = await recalculatedOrder();

        expect(actualOrder.couponCodes).toEqual([COUPON_CODE]);
        expect(actualOrder.discounts).toEqual([]);
        expect(actualOrder.subTotalWithTax).toBe(2 * CARROT_PRICE);
    });
});
