import { mergeConfig } from '@vendure/core';
import {
    createTestEnvironment,
    registerInitializer,
    SqljsInitializer,
    testConfig,
} from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { FREE_PRODUCT_ACTION_CODE } from '../free-product-action';
import { PromotionCodesPlugin } from '../promotion-codes.plugin';

/**
 * End-to-end coverage for the free_product promotion action: a real Vendure
 * server and the real order calculator, driven through the Shop API the way a
 * storefront drives it.
 *
 * What this buys over `free-product-action.spec.ts`. The unit test proves the
 * amount the action returns; nothing there proves the plugin registers the
 * action, that Vendure accepts it on a promotion, or that the order totals move.
 * A promotion whose action code is not registered gives no discount and raises
 * no error, so a green unit test says nothing about that.
 *
 * The promotion mirrors ONION649: a minimum order amount, the free product in a
 * `contains_products` condition, and the free product again in the action.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(process.cwd(), 'src/plugins/Marketing/promotion-codes/e2e/__data__');

registerInitializer('sqljs', new SqljsInitializer(dataDir));

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [PromotionCodesPlugin],
        apiOptions: { port: 3056 },
    }),
);

const COUPON_CODE = 'ONION649';
const MINIMUM_ORDER_AMOUNT = 64900;
const CARROT_PRICE = 10000;
// Deliberately not 2500, the amount the old fixed discount was typed in as.
const ONION_PRICE = 2800;

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
                actions {
                    code
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const GET_PROMOTION_ACTIONS = gql`
    query GetPromotionActions {
        promotionActions {
            code
        }
    }
`;

const ORDER_FRAGMENT = gql`
    fragment TestOrder on Order {
        id
        couponCodes
        subTotalWithTax
        lines {
            id
            quantity
            unitPriceWithTax
            discountedLinePriceWithTax
            productVariant {
                id
            }
            freeFromPromotion
        }
    }
`;

const ADD_ITEM = gql`
    mutation AddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ...TestOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;

const ADD_FREE_PRODUCT = gql`
    mutation AddFreeProduct($productVariantId: ID!, $promotionId: ID!) {
        addFreeProductToOrder(productVariantId: $productVariantId, promotionId: $promotionId) {
            ...TestOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;

const ADD_FREE_PRODUCT_QTY = gql`
    mutation AddFreeProductQty($productVariantId: ID!, $promotionId: ID!, $quantity: Int) {
        addFreeProductToOrder(productVariantId: $productVariantId, promotionId: $promotionId, quantity: $quantity) {
            ...TestOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;


const REMOVE_LINE = gql`
    mutation RemoveLine($orderLineId: ID!) {
        removeOrderLine(orderLineId: $orderLineId) {
            ...TestOrder
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
            ...TestOrder
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
            ...TestOrder
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
    ${ORDER_FRAGMENT}
`;

const REMOVE_COUPON = gql`
    mutation RemoveCoupon($couponCode: String!) {
        removeCouponCode(couponCode: $couponCode) {
            ...TestOrder
        }
    }
    ${ORDER_FRAGMENT}
`;

interface TestOrderLine {
    id: string;
    quantity: number;
    unitPriceWithTax: number;
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

describe('free_product promotion action (e2e)', () => {
    let carrotVariantId: string;
    let onionVariantId: string;
    let promotionId: string;

    const lineFor = (order: TestOrder, variantId: string): TestOrderLine => {
        const line = order.lines.find(l => l.productVariant.id === variantId);
        if (!line) {
            throw new Error(`Order has no line for variant ${variantId}`);
        }
        return line;
    };

    const createVariant = async (name: string, sku: string, price: number): Promise<string> => {
        const productResult = await adminClient.query(CREATE_PRODUCT, {
            input: {
                translations: [
                    { languageCode: 'en', name, slug: sku.toLowerCase(), description: name },
                ],
            },
        });
        const variantResult = await adminClient.query(CREATE_VARIANTS, {
            input: [
                {
                    productId: productResult.createProduct.id,
                    sku,
                    price,
                    // Stock is not what is under test; without this the cart
                    // refuses the item as out of stock.
                    trackInventory: 'FALSE',
                    translations: [{ languageCode: 'en', name }],
                },
            ],
        });
        return variantResult.createProductVariants[0].id;
    };

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();

        carrotVariantId = await createVariant('Carrot 1kg', 'CARROT', CARROT_PRICE);
        onionVariantId = await createVariant('Small onion Free 250gm', 'ONION-FREE', ONION_PRICE);
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('offers the action to the admin', async () => {
        const actualResult = await adminClient.query(GET_PROMOTION_ACTIONS);

        const actualCodes = actualResult.promotionActions.map((a: { code: string }) => a.code);
        expect(actualCodes).toContain(FREE_PRODUCT_ACTION_CODE);
    });

    it('is accepted on a promotion shaped like ONION649', async () => {
        const inputVariantIds = JSON.stringify([onionVariantId]);

        const actualResult = await adminClient.query(CREATE_PROMOTION, {
            input: {
                enabled: true,
                couponCode: COUPON_CODE,
                translations: [{ languageCode: 'en', name: COUPON_CODE }],
                conditions: [
                    {
                        code: 'minimum_order_amount',
                        arguments: [
                            { name: 'amount', value: String(MINIMUM_ORDER_AMOUNT) },
                            { name: 'taxInclusive', value: 'false' },
                        ],
                    },
                    {
                        code: 'contains_products',
                        arguments: [
                            { name: 'minimum', value: '1' },
                            { name: 'productVariantIds', value: inputVariantIds },
                        ],
                    },
                ],
                actions: [
                    {
                        code: FREE_PRODUCT_ACTION_CODE,
                        arguments: [{ name: 'productVariantIds', value: inputVariantIds }],
                    },
                ],
            },
        });

        expect(actualResult.createPromotion.message).toBeUndefined();
        expect(actualResult.createPromotion.actions).toEqual([{ code: FREE_PRODUCT_ACTION_CODE }]);
        promotionId = actualResult.createPromotion.id;
    });

    it('leaves OrderLine.customFields a plain JSON scalar in the shop API', async () => {
        // Other storefronts select `customFields` on order lines without
        // sub-fields; the tag must not change that for them.
        const actualResult = await shopClient.query(gql`
            {
                __type(name: "OrderLine") {
                    fields {
                        name
                        type { name kind ofType { name } }
                    }
                }
            }
        `);
        const fields: Array<{ name: string; type: { name: string | null; kind: string } }> =
            actualResult.__type.fields;
        expect(fields.find(f => f.name === 'customFields')?.type).toEqual({ name: 'JSON', kind: 'SCALAR', ofType: null });
        expect(fields.find(f => f.name === 'freeFromPromotion')).toBeDefined();
    });

    it('refuses to tag a product the promotion does not give away', async () => {
        await expect(
            shopClient.query(ADD_FREE_PRODUCT, { productVariantId: carrotVariantId, promotionId }),
        ).rejects.toThrow(/does not give product variant/);
    });

    it('charges for the product while no coupon is applied', async () => {
        await shopClient.query(ADD_ITEM, { productVariantId: carrotVariantId, quantity: 7 });
        // The storefront adds the free product through the dedicated mutation,
        // which tags the line with the promotion id.
        const actualResult = await shopClient.query(ADD_FREE_PRODUCT, {
            productVariantId: onionVariantId,
            promotionId,
        });

        const actualOrder: TestOrder = actualResult.addFreeProductToOrder;
        expect(lineFor(actualOrder, onionVariantId).discountedLinePriceWithTax).toBe(ONION_PRICE);
        expect(actualOrder.subTotalWithTax).toBe(7 * CARROT_PRICE + ONION_PRICE);
    });

    it('makes the product free at its own price once the coupon is applied', async () => {
        const actualResult = await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE });

        const actualOrder: TestOrder = actualResult.applyCouponCode;
        expect(actualOrder.couponCodes).toEqual([COUPON_CODE]);
        expect(lineFor(actualOrder, onionVariantId).discountedLinePriceWithTax).toBe(0);
        // The other lines keep their full price: the discount is not spread
        // across the order the way order_fixed_discount spreads it.
        expect(lineFor(actualOrder, carrotVariantId).discountedLinePriceWithTax).toBe(
            7 * CARROT_PRICE,
        );
        expect(actualOrder.subTotalWithTax).toBe(7 * CARROT_PRICE);
    });

    it("charges the customer's own, untagged line of the same product", async () => {
        // Same onion, added by the customer themselves: a second line with no
        // tag, which the coupon leaves at full price.
        const actualResult = await shopClient.query(ADD_ITEM, {
            productVariantId: onionVariantId,
            quantity: 2,
        });

        const actualOrder: TestOrder = actualResult.addItemToOrder;
        const onionLines = actualOrder.lines.filter(l => l.productVariant.id === onionVariantId);
        expect(onionLines).toHaveLength(2);
        const prices = onionLines.map(l => l.discountedLinePriceWithTax).sort((a, b) => a - b);
        expect(prices).toEqual([0, 2 * ONION_PRICE]);
        // The tag is readable, and only on the free line.
        expect(onionLines.map(l => l.freeFromPromotion).sort()).toEqual([null, promotionId].sort());
        expect(actualOrder.subTotalWithTax).toBe(7 * CARROT_PRICE + 2 * ONION_PRICE);

        // Leave the cart as the following tests expect it.
        const ownLine = onionLines.find(l => l.discountedLinePriceWithTax === 2 * ONION_PRICE)!;
        await shopClient.query(REMOVE_LINE, { orderLineId: ownLine.id });
    });

    it('frees a single unit when the customer raises the quantity', async () => {
        const orderBefore: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE }))
            .applyCouponCode;

        const actualResult = await shopClient.query(ADJUST_LINE, {
            orderLineId: lineFor(orderBefore, onionVariantId).id,
            quantity: 3,
        });

        const actualOrder: TestOrder = actualResult.adjustOrderLine;
        expect(lineFor(actualOrder, onionVariantId).discountedLinePriceWithTax).toBe(2 * ONION_PRICE);
        expect(actualOrder.subTotalWithTax).toBe(7 * CARROT_PRICE + 2 * ONION_PRICE);
    });

    it('charges for the product again when the order drops below the minimum', async () => {
        const orderBefore: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE }))
            .applyCouponCode;
        await shopClient.query(ADJUST_LINE, {
            orderLineId: lineFor(orderBefore, onionVariantId).id,
            quantity: 1,
        });

        const actualResult = await shopClient.query(ADJUST_LINE, {
            orderLineId: lineFor(orderBefore, carrotVariantId).id,
            quantity: 6,
        });

        const actualOrder: TestOrder = actualResult.adjustOrderLine;
        expect(6 * CARROT_PRICE + ONION_PRICE).toBeLessThan(MINIMUM_ORDER_AMOUNT);
        expect(lineFor(actualOrder, onionVariantId).discountedLinePriceWithTax).toBe(ONION_PRICE);
        expect(actualOrder.subTotalWithTax).toBe(6 * CARROT_PRICE + ONION_PRICE);
    });

    it('charges for the product again when the coupon is removed', async () => {
        const orderBefore: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE }))
            .applyCouponCode;
        const qualifyingOrder: TestOrder = (
            await shopClient.query(ADJUST_LINE, {
                orderLineId: lineFor(orderBefore, carrotVariantId).id,
                quantity: 7,
            })
        ).adjustOrderLine;
        expect(lineFor(qualifyingOrder, onionVariantId).discountedLinePriceWithTax).toBe(0);

        const actualResult = await shopClient.query(REMOVE_COUPON, { couponCode: COUPON_CODE });

        const actualOrder: TestOrder = actualResult.removeCouponCode;
        expect(actualOrder.couponCodes).toEqual([]);
        expect(lineFor(actualOrder, onionVariantId).discountedLinePriceWithTax).toBe(ONION_PRICE);
        expect(actualOrder.subTotalWithTax).toBe(7 * CARROT_PRICE + ONION_PRICE);
    });

    describe('a count of more than one', () => {
        // A second promotion whose admin set the onion's count to 2, stored
        // as the id listed twice. (Created rather than updated: on the e2e
        // server's test id strategy, updatePromotion decodes ID args twice.)
        const COUNT_COUPON = 'ONION2X';
        let countPromotionId: string;
        const taggedLine = (order: TestOrder) =>
            order.lines.find(l => l.productVariant.id === onionVariantId && l.freeFromPromotion === countPromotionId)!;

        it('tops the tagged line up to the count, and no further', async () => {
            const createResult = await adminClient.query(CREATE_PROMOTION, {
                input: {
                    enabled: true,
                    couponCode: COUNT_COUPON,
                    translations: [{ languageCode: 'en', name: COUNT_COUPON }],
                    conditions: [],
                    actions: [
                        {
                            code: FREE_PRODUCT_ACTION_CODE,
                            arguments: [
                                { name: 'productVariantIds', value: JSON.stringify([onionVariantId, onionVariantId]) },
                            ],
                        },
                    ],
                },
            });
            expect(createResult.createPromotion.message).toBeUndefined();
            countPromotionId = createResult.createPromotion.id;

            // Asking for 5 adds only the 2 the promotion gives.
            const first: TestOrder = (
                await shopClient.query(ADD_FREE_PRODUCT_QTY, {
                    productVariantId: onionVariantId,
                    promotionId: countPromotionId,
                    quantity: 5,
                })
            ).addFreeProductToOrder;
            expect(taggedLine(first).quantity).toBe(2);

            // Nothing more is due, so a further call changes nothing.
            const again: TestOrder = (
                await shopClient.query(ADD_FREE_PRODUCT, { productVariantId: onionVariantId, promotionId: countPromotionId })
            ).addFreeProductToOrder;
            expect(taggedLine(again).quantity).toBe(2);
        });

        it('makes every counted unit free', async () => {
            const actualOrder: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUNT_COUPON }))
                .applyCouponCode;

            expect(taggedLine(actualOrder).discountedLinePriceWithTax).toBe(0);
        });
    });

    it('answers a second removal of the same line with the order, not an error', async () => {
        // App builds up to 2.1.8 take a coupon's free lines out twice when the
        // coupon gives two or more products (OFFER300): the second pass names
        // a line the first already removed, and the app shows the error.
        const orderBefore: TestOrder = (await shopClient.query(APPLY_COUPON, { couponCode: COUPON_CODE }))
            .applyCouponCode;
        const freeLine = orderBefore.lines.find(l => l.freeFromPromotion === promotionId)!;
        const afterFirst: TestOrder = (await shopClient.query(REMOVE_LINE, { orderLineId: freeLine.id }))
            .removeOrderLine;
        expect(afterFirst.lines.map(l => l.id)).not.toContain(freeLine.id);

        const actualResult = await shopClient.query(REMOVE_LINE, { orderLineId: freeLine.id });

        const actualOrder: TestOrder = actualResult.removeOrderLine;
        expect(actualOrder.id).toBe(orderBefore.id);
        expect(actualOrder.lines).toEqual(afterFirst.lines);
    });
});
