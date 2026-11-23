import { LanguageCode, mergeConfig, PaymentMethodHandler } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { initialData } from '../../../Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { FREE_PRODUCT_ACTION_CODE } from '../free-product-action';
import { PRODUCTS_PERCENTAGE_DISCOUNT_CODE } from '../products-percentage-discount-action';
import { PromotionCodesPlugin } from '../promotion-codes.plugin';

/**
 * A placed, paid order the admin changes through "Modify order". Like a draft
 * order (see draft-order-coupon-products.e2e-spec.ts), nothing else adds a
 * coupon's products here, so the modification adds them, as their own tagged
 * line, when the coupon is applied, and takes them out when it is removed or
 * no longer applies. The dashboard previews every modification with a dry
 * run first, so the preview has to show the same lines the commit writes.
 */

const dataDir = path.join(process.cwd(), 'src/plugins/Marketing/promotion-codes/e2e/__data__');
registerInitializer('sqljs', new SqljsInitializer(dataDir));

const e2ePaymentHandler = new PaymentMethodHandler({
    code: 'e2e-pay',
    description: [{ languageCode: LanguageCode.en, value: 'e2e test payment' }],
    args: {},
    createPayment: (ctx, order, amount) => ({ amount, state: 'Settled' as const, transactionId: 'e2e' }),
    settlePayment: () => ({ success: true }),
    createRefund: () => ({ state: 'Settled' as const, transactionId: 'e2e-refund' }),
});

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [PromotionCodesPlugin],
        paymentOptions: { paymentMethodHandlers: [e2ePaymentHandler] },
        apiOptions: { port: 3064 },
    }),
);

const JUICE_PRICE = 25000;
const COOLER_PRICE = 3000;
const ONION_PRICE = 2800;
const PERCENT = 10;
/** Above the juice price, so a coupon with this minimum never applies here. */
const MINIMUM = 50000;

const ORDER_FRAGMENT = gql`
    fragment ModifyTestOrder on Order {
        id
        state
        couponCodes
        subTotalWithTax
        totalWithTax
        lines {
            id
            quantity
            discountedLinePriceWithTax
            productVariant {
                id
            }
            freeFromPromotion
        }
    }
`;
const withErrors = `
    ...ModifyTestOrder
    ... on ErrorResult {
        errorCode
        message
    }
`;
const MODIFY_ORDER = gql`
    mutation ModifyOrder($input: ModifyOrderInput!) {
        modifyOrder(input: $input) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const TRANSITION = gql`
    mutation Transition($id: ID!, $state: String!) {
        transitionOrderToState(id: $id, state: $state) { ${withErrors} }
    }
    ${ORDER_FRAGMENT}
`;
const GET_ORDER = gql`
    query GetOrder($id: ID!) {
        order(id: $id) { ...ModifyTestOrder }
    }
    ${ORDER_FRAGMENT}
`;
const SHOP_APPLY_COUPON = gql`
    mutation ShopApplyCoupon($couponCode: String!) {
        applyCouponCode(couponCode: $couponCode) {
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }
    }
`;
const SHOP_ADD_FREE_PRODUCT = gql`
    mutation ShopAddFreeProduct($productVariantId: ID!, $promotionId: ID!, $quantity: Int) {
        addFreeProductToOrder(productVariantId: $productVariantId, promotionId: $promotionId, quantity: $quantity) {
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }
    }
`;

interface TestOrderLine {
    id: string;
    quantity: number;
    discountedLinePriceWithTax: number;
    productVariant: { id: string };
    freeFromPromotion: string | null;
}
interface TestOrder {
    id: string;
    state: string;
    couponCodes: string[];
    subTotalWithTax: number;
    totalWithTax: number;
    lines: TestOrderLine[];
    errorCode?: string;
    message?: string;
}

describe('coupon products in an admin order modification (e2e)', () => {
    let juiceVariantId: string;
    let coolerVariantId: string;
    let onionVariantId: string;
    let shippingMethodId: string;
    const promotionIds: Record<string, string> = {};

    /** Lines the coupon added, still carrying units. */
    const taggedLines = (order: TestOrder, code: string) =>
        order.lines.filter(l => l.freeFromPromotion === promotionIds[code] && l.quantity > 0);
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

    const createCoupon = async (
        couponCode: string,
        actions: Array<{ code: string; arguments: unknown[] }>,
        conditions: Array<{ code: string; arguments: unknown[] }> = [],
    ) => {
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
                    conditions,
                    actions,
                },
            },
        );
        expect(result.createPromotion.message).toBeUndefined();
        promotionIds[couponCode] = result.createPromotion.id;
    };

    /**
     * A customer's paid order of [juices] juice, opened for modification;
     * [beforePaying] runs on the cart as the storefront would, with the
     * customer still shopping.
     */
    const paidOrderInModification = async (
        juices = 1,
        beforePaying: () => Promise<void> = async () => undefined,
    ): Promise<string> => {
        await shopClient.asAnonymousUser();
        await shopClient.query(
            gql`
                mutation ($productVariantId: ID!, $quantity: Int!) {
                    addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
                        ... on Order { id }
                    }
                }
            `,
            { productVariantId: juiceVariantId, quantity: juices },
        );
        await beforePaying();
        await shopClient.query(
            gql`
                mutation ($input: CreateCustomerInput!) {
                    setCustomerForOrder(input: $input) {
                        ... on Order { id }
                        ... on ErrorResult { errorCode message }
                    }
                }
            `,
            {
                input: {
                    emailAddress: `modify-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
                    firstName: 'Test',
                    lastName: 'Customer',
                },
            },
        );
        await shopClient.query(
            gql`
                mutation ($input: CreateAddressInput!) {
                    setOrderShippingAddress(input: $input) {
                        ... on Order { id }
                    }
                }
            `,
            { input: { fullName: 'Test Customer', streetLine1: '1 Main St', city: 'Madurai', countryCode: 'IN' } },
        );
        await shopClient.query(
            gql`
                mutation ($ids: [ID!]!) {
                    setOrderShippingMethod(shippingMethodId: $ids) {
                        ... on Order { id }
                    }
                }
            `,
            { ids: [shippingMethodId] },
        );
        await shopClient.query(gql`
            mutation {
                transitionOrderToState(state: "ArrangingPayment") {
                    ... on Order { id }
                }
            }
        `);
        const paid = await shopClient.query(gql`
            mutation {
                addPaymentToOrder(input: { method: "e2e-pay", metadata: {} }) {
                    ... on Order { id state }
                    ... on ErrorResult { errorCode message }
                }
            }
        `);
        expect(paid.addPaymentToOrder.state).toBe('PaymentSettled');
        const orderId: string = paid.addPaymentToOrder.id;

        const modifying: TestOrder = (await adminClient.query(TRANSITION, { id: orderId, state: 'Modifying' }))
            .transitionOrderToState;
        expect(modifying.state).toBe('Modifying');
        return orderId;
    };

    const modifyRaw = async (orderId: string, input: Record<string, unknown>, dryRun = false): Promise<TestOrder> =>
        (await adminClient.query(MODIFY_ORDER, { input: { orderId, dryRun, ...input } })).modifyOrder;
    const modify = async (
        orderId: string,
        input: Record<string, unknown>,
        dryRun = false,
    ): Promise<TestOrder> => {
        const result = await modifyRaw(orderId, input, dryRun);
        expect(result.message).toBeUndefined();
        return result;
    };
    const getOrder = async (id: string): Promise<TestOrder> => (await adminClient.query(GET_ORDER, { id })).order;
    const paymentIdOf = async (orderId: string): Promise<string> =>
        (await adminClient.query(gql`query ($id: ID!) { order(id: $id) { payments { id } } }`, { id: orderId }))
            .order.payments[0].id;

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        juiceVariantId = await createVariant('Nitro Beet 150ml', 'NITRO-BEET', JUICE_PRICE);
        coolerVariantId = await createVariant('The Internal Cooler 60ml', 'INTERNAL-COOLER', COOLER_PRICE);
        onionVariantId = await createVariant('Small onion Free 250gm', 'ONION-FREE', ONION_PRICE);

        await adminClient.query(
            gql`mutation ($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`,
            {
                input: {
                    code: 'e2e-pay',
                    enabled: true,
                    handler: { code: 'e2e-pay', arguments: [] },
                    translations: [{ languageCode: 'en', name: 'e2e test payment' }],
                },
            },
        );
        // Free delivery, so a coupon never changes what the customer paid and
        // no refund is needed to commit a modification.
        const shipping = await adminClient.query(
            gql`mutation ($input: CreateShippingMethodInput!) { createShippingMethod(input: $input) { id } }`,
            {
                input: {
                    code: 'delivery',
                    translations: [{ languageCode: 'en', name: 'Delivery' }],
                    fulfillmentHandler: 'manual-fulfillment',
                    checker: {
                        code: 'default-shipping-eligibility-checker',
                        arguments: [{ name: 'orderMinimum', value: '0' }],
                    },
                    calculator: {
                        code: 'default-shipping-calculator',
                        arguments: [
                            { name: 'rate', value: '0' },
                            { name: 'includesTax', value: 'auto' },
                            { name: 'taxRate', value: '0' },
                        ],
                    },
                },
            },
        );
        shippingMethodId = shipping.createShippingMethod.id;

        // Two onions free.
        await createCoupon('ONION649', [
            {
                code: FREE_PRODUCT_ACTION_CODE,
                arguments: [{ name: 'productVariantIds', value: JSON.stringify([onionVariantId, onionVariantId]) }],
            },
        ]);
        await createCoupon('BREADNBOOST', [
            {
                code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
                arguments: [
                    { name: 'discount', value: String(PERCENT) },
                    { name: 'productVariantIds', value: JSON.stringify([coolerVariantId]) },
                ],
            },
        ]);
        // An onion free, but only from MINIMUM upwards.
        await createCoupon(
            'MIN500',
            [
                {
                    code: FREE_PRODUCT_ACTION_CODE,
                    arguments: [{ name: 'productVariantIds', value: JSON.stringify([onionVariantId]) }],
                },
            ],
            [
                {
                    code: 'minimum_order_amount',
                    arguments: [
                        { name: 'amount', value: String(MINIMUM) },
                        { name: 'taxInclusive', value: 'true' },
                    ],
                },
            ],
        );
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    it("previews a free-product coupon's units at zero, without saving them", async () => {
        const orderId = await paidOrderInModification();
        const preview = await modify(orderId, { couponCodes: ['ONION649'] }, true);

        expect(preview.couponCodes).toEqual(['ONION649']);
        const [line] = taggedLines(preview, 'ONION649');
        expect(line.productVariant.id).toBe(onionVariantId);
        expect(line.quantity).toBe(2);
        expect(line.discountedLinePriceWithTax).toBe(0);
        expect(preview.subTotalWithTax).toBe(JUICE_PRICE);

        const saved = await getOrder(orderId);
        expect(saved.couponCodes).toEqual([]);
        expect(saved.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
    });

    it("commits the coupon's products with the modification, as the preview showed them", async () => {
        const orderId = await paidOrderInModification();
        const preview = await modify(orderId, { couponCodes: ['ONION649'] }, true);
        const committed = await modify(orderId, { couponCodes: ['ONION649'] });

        const [line] = taggedLines(committed, 'ONION649');
        expect(line.quantity).toBe(2);
        expect(line.discountedLinePriceWithTax).toBe(0);
        const shape = (o: TestOrder) =>
            o.lines.map(l => [l.productVariant.id, l.quantity, l.discountedLinePriceWithTax, l.freeFromPromotion]);
        expect(shape(committed)).toEqual(shape(preview));
        expect(committed.subTotalWithTax).toBe(JUICE_PRICE);
        expect(committed.totalWithTax).toBe(JUICE_PRICE);
        expect(await getOrder(orderId)).toEqual(committed);
    });

    it("takes the coupon's units out again when the coupon is removed", async () => {
        const orderId = await paidOrderInModification();
        const applied = await modify(orderId, { couponCodes: ['ONION649'] });
        expect(taggedLines(applied, 'ONION649')).toHaveLength(1);
        const order = await modify(orderId, { couponCodes: [] });

        expect(order.couponCodes).toEqual([]);
        expect(taggedLines(order, 'ONION649')).toHaveLength(0);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE);
        expect(await getOrder(orderId)).toEqual(order);
    });

    it('removes the coupon too when the admin takes its last product out, in the preview and the commit', async () => {
        const orderId = await paidOrderInModification();
        const applied = await modify(orderId, { couponCodes: ['ONION649'] });
        const [onion] = taggedLines(applied, 'ONION649');

        const removal = { adjustOrderLines: [{ orderLineId: onion.id, quantity: 0 }] };
        const preview = await modify(orderId, removal, true);
        expect(preview.couponCodes).toEqual([]);
        expect(taggedLines(preview, 'ONION649')).toHaveLength(0);

        const committed = await modify(orderId, removal);
        expect(committed.couponCodes).toEqual([]);
        expect(taggedLines(committed, 'ONION649')).toHaveLength(0);
        expect(committed.subTotalWithTax).toBe(JUICE_PRICE);
        expect(await getOrder(orderId)).toEqual(committed);
    });

    it("adds the product only once the order meets the coupon's condition", async () => {
        const orderId = await paidOrderInModification();
        const below = await modify(orderId, { couponCodes: ['MIN500'] });

        expect(below.couponCodes).toEqual(['MIN500']);
        expect(below.lines.map(l => l.productVariant.id)).toEqual([juiceVariantId]);
        expect(below.subTotalWithTax).toBe(JUICE_PRICE);

        // A second juice, in the same modification as the coupon, takes the
        // order to MINIMUM; the condition is judged on the modified order.
        const above = await modify(orderId, {
            couponCodes: ['MIN500'],
            addItems: [{ productVariantId: juiceVariantId, quantity: 1 }],
        });
        const [line] = taggedLines(above, 'MIN500');
        expect(line.productVariant.id).toBe(onionVariantId);
        expect(line.discountedLinePriceWithTax).toBe(0);
        expect(above.subTotalWithTax).toBe(2 * JUICE_PRICE);
    });

    it('takes the product out again when a quantity change makes the coupon stop applying', async () => {
        const orderId = await paidOrderInModification(2);
        const applied = await modify(orderId, { couponCodes: ['MIN500'] });
        const [onion] = taggedLines(applied, 'MIN500');
        expect(onion.quantity).toBe(1);
        const juice = untaggedLine(applied, juiceVariantId)!;

        // One juice fewer, refunded as Vendure requires for any price drop.
        const order = await modify(orderId, {
            adjustOrderLines: [{ orderLineId: juice.id, quantity: 1 }],
            refunds: [{ paymentId: await paymentIdOf(orderId), amount: JUICE_PRICE }],
        });

        expect(order.couponCodes).toEqual(['MIN500']);
        expect(taggedLines(order, 'MIN500')).toHaveLength(0);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE);
    });

    it("leaves a storefront order's coupon lines as the customer took them", async () => {
        // The customer took one of the two onions ONION649 gives, then paid.
        const orderId = await paidOrderInModification(1, async () => {
            const applied = await shopClient.query(SHOP_APPLY_COUPON, { couponCode: 'ONION649' });
            expect(applied.applyCouponCode.message).toBeUndefined();
            const added = await shopClient.query(SHOP_ADD_FREE_PRODUCT, {
                productVariantId: onionVariantId,
                promotionId: promotionIds.ONION649,
                quantity: 1,
            });
            expect(added.addFreeProductToOrder.message).toBeUndefined();
        });

        const order = await modify(orderId, {
            updateShippingAddress: { streetLine1: '2 Side St' },
            options: { recalculateShipping: false },
        });

        const [onion] = taggedLines(order, 'ONION649');
        expect(onion.quantity).toBe(1);
        expect(order.lines).toHaveLength(2);
        expect(order.subTotalWithTax).toBe(JUICE_PRICE);
    });

    it("asks for a refund, as Vendure does, when removing a coupon takes out a line the customer paid for", async () => {
        const orderId = await paidOrderInModification();
        const applied = await modify(orderId, { couponCodes: ['BREADNBOOST'] });
        expect(taggedLines(applied, 'BREADNBOOST')[0].discountedLinePriceWithTax).toBe(
            COOLER_PRICE - (COOLER_PRICE * PERCENT) / 100,
        );

        const refused = await modifyRaw(orderId, { couponCodes: [] });

        expect(refused.errorCode).toBe('REFUND_PAYMENT_ID_MISSING_ERROR');
        // Nothing changed: the cooler line is still there at its coupon price.
        expect(taggedLines(await getOrder(orderId), 'BREADNBOOST')).toHaveLength(1);
    });

    it("keeps the admin's own line of the product apart and charged in full", async () => {
        const orderId = await paidOrderInModification();
        const order = await modify(orderId, {
            couponCodes: ['BREADNBOOST'],
            addItems: [{ productVariantId: coolerVariantId, quantity: 2 }],
        });

        expect(untaggedLine(order, coolerVariantId)!.discountedLinePriceWithTax).toBe(2 * COOLER_PRICE);
        const [tagged] = taggedLines(order, 'BREADNBOOST');
        expect(tagged.quantity).toBe(1);
        expect(tagged.discountedLinePriceWithTax).toBe(COOLER_PRICE - (COOLER_PRICE * PERCENT) / 100);
    });
});
