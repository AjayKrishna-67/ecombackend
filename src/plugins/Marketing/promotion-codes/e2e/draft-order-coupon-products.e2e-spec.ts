import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { FREE_PRODUCT_ACTION_CODE } from '../free-product-action';
import { PRODUCTS_PERCENTAGE_DISCOUNT_CODE } from '../products-percentage-discount-action';
import { PromotionCodesPlugin } from '../promotion-codes.plugin';

/**
 * A draft order the admin builds in the dashboard. The storefronts add a
 * coupon's products themselves (addFreeProductToOrder) before the coupon can
 * discount them; in a draft order nothing does that, so applying the coupon
 * adds them, as their own tagged line, and removing it takes them out again.
 */

const dataDir = path.join(process.cwd(), 'src/plugins/Marketing/promotion-codes/e2e/__data__');
registerInitializer('sqljs', new SqljsInitializer(dataDir));

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [PromotionCodesPlugin],
        apiOptions: { port: 3062 },
    }),
);

const JUICE_PRICE = 25000;
const COOLER_PRICE = 3000;
const ONION_PRICE = 2800;
const PERCENT = 10;

const ORDER_FRAGMENT = gql`
    fragment DraftTestOrder on Order {
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
            linePriceWithTax
            discountedLinePriceWithTax
            proratedLinePriceWithTax
            productVariant {
                id
            }
            freeFromPromotion
        }
    }
`;
const withErrors = `
    ...DraftTestOrder
    ... on ErrorResult {
        errorCode
        message
    }
`;
const CREATE_DRAFT = gql`
    mutation {
        createDraftOrder {
            id
        }
    }
`;
const ADD_DRAFT_ITEM = gql`
    mutation AddDraftItem($orderId: ID!, $input: AddItemToDraftOrderInput!) {
        addItemToDraftOrder(orderId: $orderId, input: $input) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const REMOVE_DRAFT_LINE = gql`
    mutation RemoveDraftLine($orderId: ID!, $orderLineId: ID!) {
        removeDraftOrderLine(orderId: $orderId, orderLineId: $orderLineId) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const ADJUST_DRAFT_LINE = gql`
    mutation AdjustDraftLine($orderId: ID!, $input: AdjustDraftOrderLineInput!) {
        adjustDraftOrderLine(orderId: $orderId, input: $input) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const APPLY_DRAFT_COUPON = gql`
    mutation ApplyDraftCoupon($orderId: ID!, $couponCode: String!) {
        applyCouponCodeToDraftOrder(orderId: $orderId, couponCode: $couponCode) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const REMOVE_DRAFT_COUPON = gql`
    mutation RemoveDraftCoupon($orderId: ID!, $couponCode: String!) {
        removeCouponCodeFromDraftOrder(orderId: $orderId, couponCode: $couponCode) { ...DraftTestOrder }
    }
    ${ORDER_FRAGMENT}
`;
const GET_ORDER = gql`
    query GetOrder($id: ID!) {
        order(id: $id) { ...DraftTestOrder }
    }
    ${ORDER_FRAGMENT}
`;
const SHOP_ADD_ITEM = gql`
    mutation ShopAddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const SHOP_APPLY_COUPON = gql`
    mutation ShopApplyCoupon($couponCode: String!) {
        applyCouponCode(couponCode: $couponCode) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;

interface TestOrderLine {
    id: string;
    quantity: number;
    linePriceWithTax: number;
    discountedLinePriceWithTax: number;
    proratedLinePriceWithTax: number;
    productVariant: { id: string };
    freeFromPromotion: string | null;
}
interface TestOrder {
    id: string;
    couponCodes: string[];
    subTotalWithTax: number;
    discounts: Array<{ description: string; amountWithTax: number }>;
    lines: TestOrderLine[];
}

describe('coupon products in an admin draft order (e2e)', () => {
    let juiceVariantId: string;
    let coolerVariantId: string;
    let onionVariantId: string;
    const promotionIds: Record<string, string> = {};

    const taggedLines = (order: TestOrder, code: string) =>
        order.lines.filter(l => l.freeFromPromotion === promotionIds[code]);
    const untaggedLine = (order: TestOrder, variantId: string) =>
        order.lines.find(l => l.productVariant.id === variantId && l.freeFromPromotion == null);

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

    const createCoupon = async (couponCode: string, actions: Array<{ code: string; arguments: unknown[] }>) => {
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
                    couponCode,
                    translations: [{ languageCode: 'en', name: couponCode }],
                    conditions: [],
                    actions,
                },
            },
        );
        expect(result.createPromotion.message).toBeUndefined();
        promotionIds[couponCode] = result.createPromotion.id;
    };

    const newDraftWithJuice = async (): Promise<string> => {
        const orderId = (await adminClient.query(CREATE_DRAFT)).createDraftOrder.id;
        await adminClient.query(ADD_DRAFT_ITEM, {
            orderId,
            input: { productVariantId: juiceVariantId, quantity: 1 },
        });
        return orderId;
    };
    const applyCoupon = async (orderId: string, couponCode: string): Promise<TestOrder> =>
        (await adminClient.query(APPLY_DRAFT_COUPON, { orderId, couponCode })).applyCouponCodeToDraftOrder;
    const removeCoupon = async (orderId: string, couponCode: string): Promise<TestOrder> =>
        (await adminClient.query(REMOVE_DRAFT_COUPON, { orderId, couponCode })).removeCouponCodeFromDraftOrder;
    const getOrder = async (id: string): Promise<TestOrder> => (await adminClient.query(GET_ORDER, { id })).order;

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        juiceVariantId = await createVariant('Nitro Beet 150ml', 'NITRO-BEET', JUICE_PRICE);
        coolerVariantId = await createVariant('The Internal Cooler 60ml', 'INTERNAL-COOLER', COOLER_PRICE);
        onionVariantId = await createVariant('Small onion Free 250gm', 'ONION-FREE', ONION_PRICE);

        await createCoupon('BREADNBOOST', [
            {
                code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
                arguments: [
                    { name: 'discount', value: String(PERCENT) },
                    { name: 'productVariantIds', value: JSON.stringify([coolerVariantId]) },
                ],
            },
        ]);
        // Two onions free.
        await createCoupon('ONION649', [
            {
                code: FREE_PRODUCT_ACTION_CODE,
                arguments: [{ name: 'productVariantIds', value: JSON.stringify([onionVariantId, onionVariantId]) }],
            },
        ]);
        await createCoupon('ORDER10', [
            { code: 'order_percentage_discount', arguments: [{ name: 'discount', value: '10' }] },
        ]);
        // An onion free and 10% off a cooler, on one coupon.
        await createCoupon('COMBO', [
            {
                code: FREE_PRODUCT_ACTION_CODE,
                arguments: [{ name: 'productVariantIds', value: JSON.stringify([onionVariantId]) }],
            },
            {
                code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
                arguments: [
                    { name: 'discount', value: String(PERCENT) },
                    { name: 'productVariantIds', value: JSON.stringify([coolerVariantId]) },
                ],
            },
        ]);
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    it("adds a percentage coupon's product and shows its discount", async () => {
        const orderId = await newDraftWithJuice();
        const order = await applyCoupon(orderId, 'BREADNBOOST');

        expect(order.couponCodes).toEqual(['BREADNBOOST']);
        const [line] = taggedLines(order, 'BREADNBOOST');
        expect(line.productVariant.id).toBe(coolerVariantId);
        expect(line.quantity).toBe(1);
        expect(line.discountedLinePriceWithTax).toBe(COOLER_PRICE - (COOLER_PRICE * PERCENT) / 100);
        expect(order.discounts).toEqual([
            { description: 'BREADNBOOST', amountWithTax: -(COOLER_PRICE * PERCENT) / 100 },
        ]);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE + COOLER_PRICE - (COOLER_PRICE * PERCENT) / 100);
        // What the dashboard reads back afterwards is the same order.
        expect(await getOrder(orderId)).toEqual(order);
    });

    it("adds a free-product coupon's units, as many as it gives, at zero", async () => {
        const orderId = await newDraftWithJuice();
        const order = await applyCoupon(orderId, 'ONION649');

        const [line] = taggedLines(order, 'ONION649');
        expect(line.productVariant.id).toBe(onionVariantId);
        expect(line.quantity).toBe(2);
        expect(line.discountedLinePriceWithTax).toBe(0);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE);
    });

    it("takes the coupon's line out again when the coupon is removed", async () => {
        const orderId = await newDraftWithJuice();
        await applyCoupon(orderId, 'ONION649');
        const order = await removeCoupon(orderId, 'ONION649');

        expect(order.couponCodes).toEqual([]);
        expect(order.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE);
        expect(await getOrder(orderId)).toEqual(order);
    });

    it("keeps the admin's own line of the product apart and charged in full", async () => {
        const orderId = await newDraftWithJuice();
        await adminClient.query(ADD_DRAFT_ITEM, {
            orderId,
            input: { productVariantId: coolerVariantId, quantity: 2 },
        });
        const order = await applyCoupon(orderId, 'BREADNBOOST');

        expect(untaggedLine(order, coolerVariantId)!.discountedLinePriceWithTax).toBe(2 * COOLER_PRICE);
        expect(taggedLines(order, 'BREADNBOOST')).toHaveLength(1);

        const removed = await removeCoupon(orderId, 'BREADNBOOST');
        expect(untaggedLine(removed, coolerVariantId)!.quantity).toBe(2);
        expect(taggedLines(removed, 'BREADNBOOST')).toHaveLength(0);
    });

    it('removes the coupon too when the admin removes its product', async () => {
        const orderId = await newDraftWithJuice();
        const applied = await applyCoupon(orderId, 'BREADNBOOST');
        const [line] = taggedLines(applied, 'BREADNBOOST');

        const order: TestOrder = (
            await adminClient.query(REMOVE_DRAFT_LINE, { orderId, orderLineId: line.id })
        ).removeDraftOrderLine;
        expect(order.couponCodes).toEqual([]);
        expect(order.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE);
        expect(await getOrder(orderId)).toEqual(order);
    });

    it('keeps the coupon while one of its products is still on the order', async () => {
        const orderId = await newDraftWithJuice();
        const applied = await applyCoupon(orderId, 'COMBO');
        const onion = taggedLines(applied, 'COMBO').find(l => l.productVariant.id === onionVariantId)!;
        const cooler = taggedLines(applied, 'COMBO').find(l => l.productVariant.id === coolerVariantId)!;

        const afterOnion: TestOrder = (
            await adminClient.query(REMOVE_DRAFT_LINE, { orderId, orderLineId: onion.id })
        ).removeDraftOrderLine;
        expect(afterOnion.couponCodes).toEqual(['COMBO']);
        expect(taggedLines(afterOnion, 'COMBO').map(l => l.productVariant.id)).toEqual([coolerVariantId]);

        // Adding something else does not bring the removed onion back.
        await adminClient.query(ADD_DRAFT_ITEM, {
            orderId,
            input: { productVariantId: juiceVariantId, quantity: 1 },
        });
        expect(taggedLines(await getOrder(orderId), 'COMBO').map(l => l.productVariant.id)).toEqual([
            coolerVariantId,
        ]);

        // Lowering the last one to nothing is a removal as well.
        const afterCooler: TestOrder = (
            await adminClient.query(ADJUST_DRAFT_LINE, { orderId, input: { orderLineId: cooler.id, quantity: 0 } })
        ).adjustDraftOrderLine;
        expect(afterCooler.couponCodes).toEqual([]);
        expect(afterCooler.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
        expect(await getOrder(orderId)).toEqual(afterCooler);
    });

    it('adds and removes the products of a coupon with both actions', async () => {
        const orderId = await newDraftWithJuice();
        const applied = await applyCoupon(orderId, 'COMBO');
        expect(
            taggedLines(applied, 'COMBO')
                .map(l => [l.productVariant.id, l.quantity, l.discountedLinePriceWithTax])
                .sort(),
        ).toEqual(
            [
                [onionVariantId, 1, 0],
                [coolerVariantId, 1, COOLER_PRICE - (COOLER_PRICE * PERCENT) / 100],
            ].sort(),
        );

        const removed = await removeCoupon(orderId, 'COMBO');
        expect(removed.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
        expect(removed.subTotalWithTax).toBe(JUICE_PRICE);
    });

    it('keeps an order-level coupon spread over every line, the added one included', async () => {
        const orderId = await newDraftWithJuice();
        await applyCoupon(orderId, 'ORDER10');
        const added = await applyCoupon(orderId, 'BREADNBOOST');
        const afterAdd = await getOrder(orderId);
        expect(added).toEqual(afterAdd);
        // The order-level share sits in the prorated price, which a line saved
        // from before the product was added would get wrong.
        const lineTotal = (o: TestOrder) => o.lines.reduce((sum, l) => sum + l.proratedLinePriceWithTax, 0);
        expect(lineTotal(afterAdd)).toBe(afterAdd.subTotalWithTax);
        const coolerAfterCoupon = COOLER_PRICE - (COOLER_PRICE * PERCENT) / 100;
        expect(afterAdd.subTotalWithTax).toBe(Math.round(((JUICE_PRICE + coolerAfterCoupon) * (100 - 10)) / 100));

        const removed = await removeCoupon(orderId, 'BREADNBOOST');
        const afterRemove = await getOrder(orderId);
        expect(removed).toEqual(afterRemove);
        expect(lineTotal(afterRemove)).toBe(afterRemove.subTotalWithTax);
        expect(afterRemove.subTotalWithTax).toBe((JUICE_PRICE * 90) / 100);
    });

    it('leaves storefront orders to the storefronts, which add the product themselves', async () => {
        await shopClient.query(SHOP_ADD_ITEM, { productVariantId: juiceVariantId, quantity: 1 });
        const order: TestOrder = (await shopClient.query(SHOP_APPLY_COUPON, { couponCode: 'ONION649' }))
            .applyCouponCode;
        expect(order.couponCodes).toEqual(['ONION649']);
        expect(order.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
    });
});
