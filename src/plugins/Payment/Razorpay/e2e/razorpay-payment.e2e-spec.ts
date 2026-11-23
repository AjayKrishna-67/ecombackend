import * as crypto from 'crypto';
import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RazorpayPlugin } from '../razorpay.plugin';
import { initialData } from './fixtures/initial-data';

/**
 * End-to-end coverage for the app payment path: a real Vendure server, the real
 * Razorpay plugin and core addPaymentToOrder, with only Razorpay's HTTP API faked.
 *
 * What this buys over the unit specs: they stub the handler's DB connection, so
 * nothing there proves Vendure calls the handler's init(injector) at bootstrap,
 * that core treats a Declined result as "order stays unpaid", or that a guest's
 * session passes the shop resolvers' ownership guard.
 */

// Razorpay's SDK is the only fake. Orders and payments live in this map so a test
// can decide what Razorpay "says" about a payment id.
const razorpayStub = vi.hoisted(() => ({ payments: new Map<string, Record<string, unknown>>() }));
vi.mock('razorpay', () => ({
    default: class FakeRazorpay {
        orders = {
            create: async (input: { amount: number; currency: string }) => ({
                id: 'order_e2e_1',
                amount: input.amount,
                currency: input.currency,
                status: 'created',
            }),
            fetch: async (id: string) => ({ id, status: 'created', amount: 0 }),
        };
        payments = {
            fetch: async (id: string) => {
                const payment = razorpayStub.payments.get(id);
                if (!payment) {
                    throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
                }
                return payment;
            },
        };
    },
}));

const KEYS = { key_id: 'rzp_test_e2e', key_secret: 'e2e_key_secret' };

const dataDir = path.join(process.cwd(), 'src/plugins/Payment/Razorpay/e2e/__data__');
registerInitializer('sqljs', new SqljsInitializer(dataDir));

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [RazorpayPlugin],
        // Not the default 3050, and not 3055 (scheduled-availability suite).
        apiOptions: { port: 3056 },
        // The plugin expects these on Order; production defines them in vendure-config-custom-fields.ts.
        customFields: {
            Order: [
                { name: 'razorpayOrderId', type: 'string', public: false, nullable: true },
                { name: 'razorpayPaymentId', type: 'string', public: false, nullable: true },
                { name: 'isPaymentWindowOpen', type: 'boolean', defaultValue: false, public: false },
            ],
        },
    }),
);

const CREATE_PRODUCT = gql`
    mutation CreateProduct($input: CreateProductInput!) {
        createProduct(input: $input) { id }
    }
`;

const CREATE_VARIANTS = gql`
    mutation CreateVariants($input: [CreateProductVariantInput!]!) {
        createProductVariants(input: $input) { id }
    }
`;

const CREATE_PAYMENT_METHOD = gql`
    mutation CreatePaymentMethod($input: CreatePaymentMethodInput!) {
        createPaymentMethod(input: $input) { id code }
    }
`;

const ADD_ITEM = gql`
    mutation AddItem($variantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $variantId, quantity: $quantity) {
            ... on Order { id code state totalWithTax }
            ... on ErrorResult { errorCode message }
        }
    }
`;

const SET_CUSTOMER = gql`
    mutation SetCustomer($input: CreateCustomerInput!) {
        setCustomerForOrder(input: $input) {
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }
    }
`;

const SET_ADDRESS = gql`
    mutation SetAddress($input: CreateAddressInput!) {
        setOrderShippingAddress(input: $input) {
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }
    }
`;

const ELIGIBLE_SHIPPING = gql`
    query Eligible {
        eligibleShippingMethods { id }
    }
`;

const SET_SHIPPING = gql`
    mutation SetShipping($ids: [ID!]!) {
        setOrderShippingMethod(shippingMethodId: $ids) {
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }
    }
`;

const GENERATE_RAZORPAY_ORDER = gql`
    mutation Generate($orderId: ID!) {
        generateRazorpayOrderId(orderId: $orderId) { success razorpayOrderId amount errorMessage }
    }
`;

const ADD_PAYMENT = gql`
    mutation AddPayment($input: PaymentInput!) {
        addPaymentToOrder(input: $input) {
            ... on Order {
                id
                state
                totalWithTax
                payments { state amount transactionId }
            }
            ... on PaymentDeclinedError { errorCode paymentErrorMessage }
            ... on ErrorResult { errorCode message }
        }
    }
`;

const ACTIVE_ORDER = gql`
    query ActiveOrder {
        activeOrder { id state }
    }
`;

function signCheckout(razorpayOrderId: string, razorpayPaymentId: string): string {
    return crypto.createHmac('sha256', KEYS.key_secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
}

describe('Razorpay app payment path (e2e)', () => {
    let orderId: string;
    let orderTotal: number;
    let razorpayOrderId: string;

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        const { createProduct } = await adminClient.query(CREATE_PRODUCT, {
            input: { translations: [{ languageCode: 'en', name: 'Tomato', slug: 'tomato', description: 'e2e' }] },
        });
        const { createProductVariants } = await adminClient.query(CREATE_VARIANTS, {
            input: [{
                productId: createProduct.id,
                sku: 'TOMATO-1KG',
                price: 25000,
                stockOnHand: 100,
                translations: [{ languageCode: 'en', name: 'Tomato 1kg' }],
            }],
        });
        await adminClient.query(CREATE_PAYMENT_METHOD, {
            input: {
                code: 'razorpay-payment',
                enabled: true,
                handler: { code: 'razorpay-payment', arguments: [{ name: 'config', value: JSON.stringify(KEYS) }] },
                translations: [{ languageCode: 'en', name: 'Razorpay' }],
            },
        });

        // A guest checkout up to tap-Pay: the guest's session is what the
        // ownership guard on generateRazorpayOrderId has to accept.
        await shopClient.asAnonymousUser();
        const { addItemToOrder } = await shopClient.query(ADD_ITEM, { variantId: createProductVariants[0].id, quantity: 1 });
        orderId = addItemToOrder.id;
        orderTotal = addItemToOrder.totalWithTax;
        await shopClient.query(SET_CUSTOMER, { input: { emailAddress: 'guest@example.com', firstName: 'Guest', lastName: 'Buyer' } });
        await shopClient.query(SET_ADDRESS, { input: { streetLine1: '1 Market Road', countryCode: 'IN' } });
        const { eligibleShippingMethods } = await shopClient.query(ELIGIBLE_SHIPPING);
        await shopClient.query(SET_SHIPPING, { ids: [eligibleShippingMethods[0].id] });
        const { generateRazorpayOrderId } = await shopClient.query(GENERATE_RAZORPAY_ORDER, { orderId });
        expect(generateRazorpayOrderId).toMatchObject({ success: true, amount: orderTotal });
        razorpayOrderId = generateRazorpayOrderId.razorpayOrderId;
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('declines the old free-order shortcut and leaves the order unpaid', async () => {
        const { addPaymentToOrder } = await shopClient.query(ADD_PAYMENT, {
            input: { method: 'razorpay-payment', metadata: { source: 'webhook', paymentId: 'pay_free', webhookData: {} } },
        });
        expect(addPaymentToOrder.errorCode).toBe('PAYMENT_DECLINED_ERROR');
        const { activeOrder } = await shopClient.query(ACTIVE_ORDER);
        expect(activeOrder).toMatchObject({ id: orderId, state: 'ArrangingPayment' });
    });

    it('settles a payment Razorpay confirms as captured, recording exactly one Settled payment', async () => {
        razorpayStub.payments.set('pay_e2e_1', {
            id: 'pay_e2e_1',
            order_id: razorpayOrderId,
            status: 'captured',
            amount: orderTotal,
        });
        const { addPaymentToOrder } = await shopClient.query(ADD_PAYMENT, {
            input: {
                method: 'razorpay-payment',
                metadata: {
                    razorpayOrderId,
                    razorpayPaymentId: 'pay_e2e_1',
                    razorpaySignature: signCheckout(razorpayOrderId, 'pay_e2e_1'),
                },
            },
        });
        expect(addPaymentToOrder.state).toBe('PaymentSettled');
        const settled = addPaymentToOrder.payments.filter((p: { state: string }) => p.state === 'Settled');
        expect(settled).toEqual([{ state: 'Settled', amount: orderTotal, transactionId: 'pay_e2e_1' }]);
    });
});
