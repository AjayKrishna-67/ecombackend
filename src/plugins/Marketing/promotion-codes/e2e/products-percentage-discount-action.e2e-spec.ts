import { mergeConfig, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { CouponUnitPercentageDiscount1792200000000 } from '../../../../migrations/1792200000000-coupon-unit-percentage-discount';
import { PRODUCTS_PERCENTAGE_DISCOUNT_CODE } from '../products-percentage-discount-action';
import { PromotionCodesPlugin } from '../promotion-codes.plugin';

/**
 * End-to-end coverage for products_percentage_discount ("Discount specified
 * products by %"), which this plugin takes over from Vendure core: a real Vendure
 * server and order calculator, driven through the Shop API the way the apps
 * and the website drive it. The promotion mirrors BREADNBOOST: 10% off The
 * Internal Cooler 60ml. The point of the action is that the discount stays
 * on the coupon's own unit, whatever the customer does to the quantity.
 */

const dataDir = path.join(process.cwd(), 'src/plugins/Marketing/promotion-codes/e2e/__data__');
registerInitializer('sqljs', new SqljsInitializer(dataDir));

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [PromotionCodesPlugin],
        apiOptions: { port: 3058 },
    }),
);

const COUPON_CODE = 'BREADNBOOST';
const COOLER_PRICE = 3000;
const JUICE_PRICE = 25000;
const PERCENT = 10;
const COUPON_OFF = (COOLER_PRICE * PERCENT) / 100;

const ORDER_FRAGMENT = gql`
    fragment TestOrder on Order {
        id
        couponCodes
        subTotalWithTax
        lines {
            id
            quantity
            linePriceWithTax
            discountedLinePriceWithTax
            productVariant {
                id
            }
            freeFromPromotion
        }
    }
`;
const withErrors = `
    ...TestOrder
    ... on ErrorResult {
        errorCode
        message
    }
`;
const ADD_ITEM = gql`
    mutation AddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const ADD_COUPON_PRODUCT = gql`
    mutation AddCouponProduct($productVariantId: ID!, $promotionId: ID!, $quantity: Int) {
        addFreeProductToOrder(productVariantId: $productVariantId, promotionId: $promotionId, quantity: $quantity) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const ADJUST_LINE = gql`
    mutation AdjustLine($orderLineId: ID!, $quantity: Int!) {
        adjustOrderLine(orderLineId: $orderLineId, quantity: $quantity) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const APPLY_COUPON = gql`
    mutation ApplyCoupon($couponCode: String!) {
        applyCouponCode(couponCode: $couponCode) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const REMOVE_COUPON = gql`
    mutation RemoveCoupon($couponCode: String!) {
        removeCouponCode(couponCode: $couponCode) { ...TestOrder }
    }
    ${ORDER_FRAGMENT}
`;
const COUPON_LIST = gql`
    query CouponList {
        getCouponCodeList {
            items {
                promotion { couponCode }
                productVariants { id }
            }
        }
    }
`;

interface TestOrderLine {
    id: string;
    quantity: number;
    linePriceWithTax: number;
    discountedLinePriceWithTax: number;
    productVariant: { id: string };
    freeFromPromotion: string | null;
}
interface TestOrder {
    id: string;
    couponCodes: string[];
    subTotalWithTax: number;
    lines: TestOrderLine[];
}

describe('products_percentage_discount promotion action (e2e)', () => {
    let juiceVariantId: string;
    let coolerVariantId: string;
    let promotionId: string;

    const couponLine = (order: TestOrder) =>
        order.lines.find(l => l.productVariant.id === coolerVariantId && l.freeFromPromotion === promotionId)!;
    const ownLine = (order: TestOrder, variantId: string) =>
        order.lines.find(l => l.productVariant.id === variantId && l.freeFromPromotion == null)!;

    const createVariant = async (name: string, sku: string, price: number): Promise<string> => {
        const product = await adminClient.query(
            gql`mutation ($input: CreateProductInput!) { createProduct(input: $input) { id } }`,
            { input: { translations: [{ languageCode: 'en', name, slug: sku.toLowerCase(), description: name }] } },
        );
        const variants = await adminClient.query(
            gql`mutation ($input: [CreateProductVariantInput!]!) { createProductVariants(input: $input) { id } }`,
            {
                input: [
                    {
                        productId: product.createProduct.id,
                        sku,
                        price,
                        trackInventory: 'FALSE',
                        translations: [{ languageCode: 'en', name }],
                    },
                ],
            },
        );
        return variants.createProductVariants[0].id;
    };

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        juiceVariantId = await createVariant('Nitro Beet 150ml', 'NITRO-BEET', JUICE_PRICE);
        coolerVariantId = await createVariant('The Internal Cooler 60ml', 'INTERNAL-COOLER', COOLER_PRICE);
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    it("offers the admin this action, once, in place of core's", async () => {
        const result = await adminClient.query(
            gql`{ promotionActions { code description args { name ui } } }`,
        );
        const matches = result.promotionActions.filter(
            (a: { code: string }) => a.code === PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
        );
        expect(matches).toHaveLength(1);
        expect(matches[0].description).toBe('Discount specified products by { discount }%');
        // The count box, not core's plain product selector.
        const products = matches[0].args.find((a: { name: string }) => a.name === 'productVariantIds');
        expect(products.ui.component).toBe('free-product-quantity-input');
        // The interim separate action is gone.
        expect(result.promotionActions.map((a: { code: string }) => a.code)).not.toContain(
            'coupon_product_percentage_discount',
        );
    });

    it('is accepted on a promotion shaped like BREADNBOOST', async () => {
        const result = await adminClient.query(
            gql`
                mutation ($input: CreatePromotionInput!) {
                    createPromotion(input: $input) {
                        ... on Promotion { id actions { code } }
                        ... on ErrorResult { errorCode message }
                    }
                }
            `,
            {
                input: {
                    enabled: true,
                    couponCode: COUPON_CODE,
                    translations: [{ languageCode: 'en', name: COUPON_CODE }],
                    conditions: [],
                    actions: [
                        {
                            code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
                            arguments: [
                                { name: 'discount', value: String(PERCENT) },
                                { name: 'productVariantIds', value: JSON.stringify([coolerVariantId]) },
                            ],
                        },
                    ],
                },
            },
        );
        expect(result.createPromotion.message).toBeUndefined();
        promotionId = result.createPromotion.id;
    });

    it("names the product in the coupon list, so the storefronts can add it", async () => {
        const result = await shopClient.query(COUPON_LIST);
        const item = result.getCouponCodeList.items.find(
            (i: { promotion: { couponCode: string } }) => i.promotion.couponCode === COUPON_CODE,
        );
        expect(item.productVariants.map((v: { id: string }) => v.id)).toEqual([coolerVariantId]);
    });

    it("adds the coupon's unit as its own tagged line, never more than the count", async () => {
        await shopClient.query(ADD_ITEM, { productVariantId: juiceVariantId, quantity: 1 });
        const order: TestOrder = (
            await shopClient.query(ADD_COUPON_PRODUCT, {
                productVariantId: coolerVariantId,
                promotionId,
                quantity: 3,
            })
        ).addFreeProductToOrder;
        expect(couponLine(order).quantity).toBe(1);
    });

    it('takes the percentage off that unit once the coupon is applied', async () => {
        const order: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE })).applyCouponCode;
        expect(order.couponCodes).toEqual([COUPON_CODE]);
        expect(couponLine(order).discountedLinePriceWithTax).toBe(COOLER_PRICE - COUPON_OFF);
        expect(ownLine(order, juiceVariantId).discountedLinePriceWithTax).toBe(JUICE_PRICE);
    });

    it('keeps the same discount when the quantity of the coupon line is raised', async () => {
        const before: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE })).applyCouponCode;
        const order: TestOrder = (
            await shopClient.query(ADJUST_LINE, { orderLineId: couponLine(before).id, quantity: 3 })
        ).adjustOrderLine;
        expect(couponLine(order).discountedLinePriceWithTax).toBe(3 * COOLER_PRICE - COUPON_OFF);
        // Back to one unit for the following tests.
        await shopClient.query(ADJUST_LINE, { orderLineId: couponLine(before).id, quantity: 1 });
    });

    it('puts a unit the customer adds on its own line, at full price', async () => {
        const order: TestOrder = (await shopClient.query(ADD_ITEM, { productVariantId: coolerVariantId, quantity: 2 }))
            .addItemToOrder;
        const coolerLines = order.lines.filter(l => l.productVariant.id === coolerVariantId);
        expect(coolerLines).toHaveLength(2);
        expect(ownLine(order, coolerVariantId).discountedLinePriceWithTax).toBe(2 * COOLER_PRICE);
        expect(couponLine(order).discountedLinePriceWithTax).toBe(COOLER_PRICE - COUPON_OFF);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE + 3 * COOLER_PRICE - COUPON_OFF);
    });

    describe('the migration from the interim coupon_product_percentage_discount code', () => {
        const MIGRATED_CODE = 'INTERIMCODE';
        let migratedId: string;
        const rawQuery = async (sql: string, params: unknown[] = []) =>
            server.app.get(TransactionalConnection).rawConnection.query(sql, params);
        const actionCodes = async () =>
            (
                await adminClient.query(gql`query ($id: ID!) { promotion(id: $id) { actions { code } } }`, {
                    id: migratedId,
                })
            ).promotion.actions.map((a: { code: string }) => a.code);

        it('renames a coupon saved with the interim code, which this build no longer registers', async () => {
            const result = await adminClient.query(
                gql`
                    mutation ($input: CreatePromotionInput!) {
                        createPromotion(input: $input) {
                            ... on Promotion { id }
                            ... on ErrorResult { errorCode message }
                        }
                    }
                `,
                {
                    input: {
                        enabled: true,
                        couponCode: MIGRATED_CODE,
                        translations: [{ languageCode: 'en', name: MIGRATED_CODE }],
                        conditions: [],
                        actions: [
                            {
                                code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
                                arguments: [
                                    { name: 'discount', value: '50' },
                                    { name: 'productVariantIds', value: JSON.stringify([coolerVariantId]) },
                                ],
                            },
                        ],
                    },
                },
            );
            migratedId = result.createPromotion.id;
            // Saved by the interim build, as the database holds it there.
            await rawQuery(
                "UPDATE promotion SET actions = REPLACE(actions, '\"products_percentage_discount\"', '\"coupon_product_percentage_discount\"') WHERE couponCode = ?",
                [MIGRATED_CODE],
            );
            expect(await actionCodes()).toEqual(['coupon_product_percentage_discount']);

            const queryRunner = server.app.get(TransactionalConnection).rawConnection.createQueryRunner();
            try {
                await new CouponUnitPercentageDiscount1792200000000().up(queryRunner);
            } finally {
                await queryRunner.release();
            }

            expect(await actionCodes()).toEqual([PRODUCTS_PERCENTAGE_DISCOUNT_CODE]);
        });

        it('and the renamed coupon applies, discounting its own unit', async () => {
            await shopClient.query(REMOVE_COUPON, { couponCode: COUPON_CODE });
            const added: TestOrder = (
                await shopClient.query(ADD_COUPON_PRODUCT, { productVariantId: coolerVariantId, promotionId: migratedId })
            ).addFreeProductToOrder;
            const line = added.lines.find(
                l => l.productVariant.id === coolerVariantId && l.freeFromPromotion === migratedId,
            )!;
            const order: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: MIGRATED_CODE }))
                .applyCouponCode;
            expect(order.lines.find(l => l.id === line.id)!.discountedLinePriceWithTax).toBe(COOLER_PRICE / 2);

            await shopClient.query(REMOVE_COUPON, { couponCode: MIGRATED_CODE });
            await shopClient.query(gql`mutation ($id: ID!) { removeOrderLine(orderLineId: $id) { ... on Order { id } } }`, {
                id: line.id,
            });
            await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE });
        });
    });

    it('charges the coupon unit in full again when the coupon is removed', async () => {
        const order: TestOrder = (await shopClient.query(REMOVE_COUPON, { couponCode: COUPON_CODE })).removeCouponCode;
        expect(couponLine(order).discountedLinePriceWithTax).toBe(COOLER_PRICE);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE + 3 * COOLER_PRICE);
    });
});
