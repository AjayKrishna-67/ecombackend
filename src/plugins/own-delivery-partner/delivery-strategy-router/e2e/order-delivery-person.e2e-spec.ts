import { LanguageCode, mergeConfig, PaymentMethodHandler } from '@vendure/core';
import {
    createTestEnvironment,
    registerInitializer,
    SqljsInitializer,
    testConfig,
} from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { customFields } from '../../../../vendure-config-custom-fields';
import { DeliveryStrategyRouterPlugin } from '../delivery-strategy-router.plugin';
import { DeliveryReportService } from '../services/delivery-report.service';

/**
 * End-to-end coverage for `Order.deliveryPerson` on the Shop API with our
 * own delivery fleet: a real Vendure server with the delivery plugin's
 * handler, fulfillment process, order process and state subscriber, driven
 * the way the admin and the customer's app drive it.
 *
 * The field is for Adloggs riders only (see the Adloggs e2e). This suite
 * proves the field is in the shop schema and that our own delivery staff's
 * name and number never reach the customer at any stage, nor through the
 * internal Fulfillment custom fields.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(
    process.cwd(),
    'src/plugins/own-delivery-partner/delivery-strategy-router/e2e/__data__',
);

registerInitializer('sqljs', new SqljsInitializer(dataDir));

// The report service backfills legacy fulfillments at bootstrap with a
// MySQL-only `UPDATE ... INNER JOIN`, which sql.js rejects and which would
// abort the server start. There is nothing to backfill in a fresh database,
// so the backfill is skipped here; nothing else in the plugin needs MySQL,
// Redis or Google at bootstrap.
vi.spyOn(DeliveryReportService.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);

// Settles immediately, so an order can be placed without a gateway.
const e2ePaymentHandler = new PaymentMethodHandler({
    code: 'e2e-pay',
    description: [{ languageCode: LanguageCode.en, value: 'e2e test payment' }],
    args: {},
    createPayment: (ctx, order, amount) => ({ amount, state: 'Settled' as const, transactionId: 'e2e' }),
    settlePayment: () => ({ success: true }),
});

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [DeliveryStrategyRouterPlugin],
        paymentOptions: { paymentMethodHandlers: [e2ePaymentHandler] },
        // The handler reads the delivery person's phone from this field.
        customFields: { Administrator: customFields!.Administrator },
        apiOptions: { port: 3059 },
    }),
);

const RIDER = { firstName: 'Ravi', lastName: 'Kumar', phoneNumber: '9876543210' };

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

const CREATE_SHIPPING_METHOD = gql`
    mutation CreateShippingMethod($input: CreateShippingMethodInput!) {
        createShippingMethod(input: $input) {
            id
        }
    }
`;

const CREATE_PAYMENT_METHOD = gql`
    mutation CreatePaymentMethod($input: CreatePaymentMethodInput!) {
        createPaymentMethod(input: $input) {
            id
        }
    }
`;

const CREATE_ROLE = gql`
    mutation CreateRole($input: CreateRoleInput!) {
        createRole(input: $input) {
            id
        }
    }
`;

const CREATE_ADMINISTRATOR = gql`
    mutation CreateAdministrator($input: CreateAdministratorInput!) {
        createAdministrator(input: $input) {
            id
            customFields {
                phoneNumber
            }
        }
    }
`;

const GET_CUSTOMERS = gql`
    query GetCustomers {
        customers(options: { take: 1 }) {
            items {
                emailAddress
            }
        }
    }
`;

const ADD_FULFILLMENT = gql`
    mutation AddFulfillment($input: FulfillOrderInput!) {
        addFulfillmentToOrder(input: $input) {
            ... on Fulfillment {
                id
                state
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const TRANSITION_FULFILLMENT = gql`
    mutation TransitionFulfillment($id: ID!, $state: String!) {
        transitionFulfillmentToState(id: $id, state: $state) {
            ... on Fulfillment {
                id
                state
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const ADMIN_ORDER = gql`
    query AdminOrder($id: ID!) {
        order(id: $id) {
            id
            state
            lines {
                id
                quantity
            }
            fulfillments {
                id
                state
            }
        }
    }
`;

const ADD_ITEM = gql`
    mutation AddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ... on Order {
                id
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const SET_SHIPPING_METHOD = gql`
    mutation SetShippingMethod($ids: [ID!]!) {
        setOrderShippingMethod(shippingMethodId: $ids) {
            ... on Order {
                id
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const TRANSITION_ORDER = gql`
    mutation TransitionOrder($state: String!) {
        transitionOrderToState(state: $state) {
            ... on Order {
                id
                state
            }
            ... on OrderStateTransitionError {
                errorCode
                message
                transitionError
            }
        }
    }
`;

const ADD_PAYMENT = gql`
    mutation AddPayment($input: PaymentInput!) {
        addPaymentToOrder(input: $input) {
            ... on Order {
                id
                code
                state
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const ORDER_BY_CODE = gql`
    query OrderByCode($code: String!) {
        orderByCode(code: $code) {
            code
            state
            deliveryPerson {
                name
                phoneNumber
            }
            fulfillments {
                state
                customFields
            }
        }
    }
`;

const MY_ORDERS = gql`
    query MyOrders {
        activeCustomer {
            orders {
                items {
                    code
                    state
                    deliveryPerson {
                        name
                        phoneNumber
                    }
                }
            }
        }
    }
`;

interface ShopOrder {
    code: string;
    state: string;
    deliveryPerson: { name: string; phoneNumber: string | null } | null;
    fulfillments: Array<{ state: string; customFields: unknown }>;
}

/** The handler's arg is raw JSON, so the id inside it is the database id. */
const databaseId = (id: string) => id.replace(/^T_/, '');

describe('Order.deliveryPerson on the shop API (e2e)', () => {
    let variantId: string;
    let shippingMethodId: string;
    let riderId: string;
    let orderId: string;
    let orderCode: string;
    let fulfillmentId: string;

    const shopOrder = async (): Promise<ShopOrder> =>
        (await shopClient.query(ORDER_BY_CODE, { code: orderCode })).orderByCode;

    /**
     * The state subscriber reacts after the admin mutation commits, so the
     * order (and the auto-shipped fulfillment) settle a moment later.
     */
    const waitForOrderState = async (state: string) => {
        let actualState = '';
        for (let attempt = 0; attempt < 50; attempt++) {
            const result = await adminClient.query(ADMIN_ORDER, { id: orderId });
            actualState = result.order.state;
            if (actualState === state) {
                return result.order;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Order stayed in "${actualState}", expected "${state}"`);
    };

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 1 });
        await adminClient.asSuperAdmin();

        const productResult = await adminClient.query(CREATE_PRODUCT, {
            input: {
                translations: [{ languageCode: 'en', name: 'Carrot 1kg', slug: 'carrot', description: 'Carrot' }],
            },
        });
        const variantResult = await adminClient.query(CREATE_VARIANTS, {
            input: [
                {
                    productId: productResult.createProduct.id,
                    sku: 'CARROT',
                    price: 10000,
                    trackInventory: 'FALSE',
                    translations: [{ languageCode: 'en', name: 'Carrot 1kg' }],
                },
            ],
        });
        variantId = variantResult.createProductVariants[0].id;

        await adminClient.query(CREATE_PAYMENT_METHOD, {
            input: {
                code: 'e2e-pay',
                enabled: true,
                handler: { code: 'e2e-pay', arguments: [] },
                translations: [{ languageCode: 'en', name: 'e2e test payment' }],
            },
        });

        const shippingResult = await adminClient.query(CREATE_SHIPPING_METHOD, {
            input: {
                code: 'delivery',
                translations: [{ languageCode: 'en', name: 'Delivery' }],
                fulfillmentHandler: 'kaaikani-fulfillment',
                checker: {
                    code: 'default-shipping-eligibility-checker',
                    arguments: [{ name: 'orderMinimum', value: '0' }],
                },
                calculator: {
                    code: 'default-shipping-calculator',
                    arguments: [
                        { name: 'rate', value: '5000' },
                        { name: 'includesTax', value: 'auto' },
                        { name: 'taxRate', value: '0' },
                    ],
                },
            },
        });
        shippingMethodId = shippingResult.createShippingMethod.id;

        const roleResult = await adminClient.query(CREATE_ROLE, {
            input: {
                code: 'delivery-person',
                description: 'Delivery person',
                permissions: ['TransitionToOutForDelivery', 'TransitionToDelivered'],
            },
        });
        const riderResult = await adminClient.query(CREATE_ADMINISTRATOR, {
            input: {
                firstName: RIDER.firstName,
                lastName: RIDER.lastName,
                emailAddress: 'rider@example.com',
                password: 'rider-password',
                roleIds: [roleResult.createRole.id],
                customFields: { phoneNumber: RIDER.phoneNumber },
            },
        });
        expect(riderResult.createAdministrator.customFields.phoneNumber).toBe(RIDER.phoneNumber);
        riderId = riderResult.createAdministrator.id;

        // A registered customer, so activeCustomer.orders can be checked too.
        const customersResult = await adminClient.query(GET_CUSTOMERS);
        await shopClient.asUserWithCredentials(customersResult.customers.items[0].emailAddress, 'test');
    }, 180_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        await server.destroy();
    });

    it('adds deliveryPerson to the shop Order type and leaves Fulfillment.customFields JSON', async () => {
        const actualResult = await shopClient.query(gql`
            {
                order: __type(name: "Order") {
                    fields {
                        name
                        type {
                            name
                            kind
                        }
                    }
                }
                person: __type(name: "OrderDeliveryPerson") {
                    fields {
                        name
                        type {
                            name
                            kind
                            ofType {
                                name
                            }
                        }
                    }
                }
                fulfillment: __type(name: "Fulfillment") {
                    fields {
                        name
                        type {
                            name
                            kind
                            ofType {
                                name
                            }
                        }
                    }
                }
            }
        `);

        type Field = { name: string; type: { name: string | null; kind: string; ofType?: { name: string } | null } };
        const orderFields: Field[] = actualResult.order.fields;
        expect(orderFields.find(f => f.name === 'deliveryPerson')?.type).toEqual({
            name: 'OrderDeliveryPerson',
            kind: 'OBJECT',
        });
        const personFields: Field[] = actualResult.person.fields;
        expect(personFields.map(f => [f.name, f.type.kind, f.type.name ?? f.type.ofType?.name])).toEqual([
            ['name', 'NON_NULL', 'String'],
            ['phoneNumber', 'SCALAR', 'String'],
            ['deliveryOtp', 'SCALAR', 'String'],
        ]);
        // Every Fulfillment custom field is internal, so the shop API keeps the
        // plain JSON scalar and no typed FulfillmentCustomFields object exists.
        const fulfillmentFields: Field[] = actualResult.fulfillment.fields;
        expect(fulfillmentFields.find(f => f.name === 'customFields')?.type).toEqual({
            name: 'JSON',
            kind: 'SCALAR',
            ofType: null,
        });
    });

    it('is null while the order is placed but not yet fulfilled', async () => {
        await shopClient.query(ADD_ITEM, { productVariantId: variantId, quantity: 2 });
        await shopClient.query(SET_SHIPPING_METHOD, { ids: [shippingMethodId] });
        const transitionResult = await shopClient.query(TRANSITION_ORDER, { state: 'ArrangingPayment' });
        expect(transitionResult.transitionOrderToState.state).toBe('ArrangingPayment');
        const payResult = await shopClient.query(ADD_PAYMENT, { input: { method: 'e2e-pay', metadata: {} } });
        expect(payResult.addPaymentToOrder.state).toBe('PaymentSettled');
        orderId = payResult.addPaymentToOrder.id;
        orderCode = payResult.addPaymentToOrder.code;

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('PaymentSettled');
        expect(actualOrder.deliveryPerson).toBeNull();
    });

    it('is null once the rider is assigned and the order is shipped, before it goes out', async () => {
        const adminOrder = (await adminClient.query(ADMIN_ORDER, { id: orderId })).order;
        const fulfillResult = await adminClient.query(ADD_FULFILLMENT, {
            input: {
                lines: adminOrder.lines.map((l: { id: string; quantity: number }) => ({
                    orderLineId: l.id,
                    quantity: l.quantity,
                })),
                handler: {
                    code: 'kaaikani-fulfillment',
                    arguments: [
                        {
                            name: 'fulfillmentConfig',
                            value: JSON.stringify({ type: 'own-delivery-fleet', deliveryPersonId: databaseId(riderId) }),
                        },
                    ],
                },
            },
        });
        expect(fulfillResult.addFulfillmentToOrder.message).toBeUndefined();
        fulfillmentId = fulfillResult.addFulfillmentToOrder.id;

        // In production the state subscriber auto-ships own-fleet fulfillments.
        // Its transition takes a pessimistic_write row lock, which sql.js does
        // not support ("Locking not supported on given driver"), so here it
        // logs an error and the admin ships the fulfillment instead. Core then
        // moves the order to Shipped with it, as it does after the auto-ship.
        const shipResult = await adminClient.query(TRANSITION_FULFILLMENT, {
            id: fulfillmentId,
            state: 'Shipped',
        });
        expect(shipResult.transitionFulfillmentToState.message).toBeUndefined();
        const shippedOrder = await waitForOrderState('Shipped');
        expect(shippedOrder.fulfillments.map((f: { state: string }) => f.state)).toEqual(['Shipped']);

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('Shipped');
        expect(actualOrder.deliveryPerson).toBeNull();
    });

    it("never gives out our own rider's name or number, even out for delivery", async () => {
        const transitionResult = await adminClient.query(TRANSITION_FULFILLMENT, {
            id: fulfillmentId,
            state: 'OutforDelivery',
        });
        expect(transitionResult.transitionFulfillmentToState.message).toBeUndefined();
        await waitForOrderState('OutforDelivery');

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('OutforDelivery');
        expect(actualOrder.deliveryPerson).toBeNull();
    });

    it('gives nobody in the customer order history either', async () => {
        const actualResult = await shopClient.query(MY_ORDERS);

        const actualOrder = actualResult.activeCustomer.orders.items.find(
            (o: { code: string }) => o.code === orderCode,
        );
        expect(actualOrder.state).toBe('OutforDelivery');
        expect(actualOrder.deliveryPerson).toBeNull();
    });

    it('does not leak the internal fulfillment fields that hold the snapshot', async () => {
        const actualOrder = await shopOrder();

        expect(actualOrder.fulfillments).toHaveLength(1);
        expect(actualOrder.fulfillments[0].state).toBe('OutforDelivery');
        expect(actualOrder.fulfillments[0].customFields).toBeNull();
    });

    it('is null again once the order is delivered', async () => {
        const transitionResult = await adminClient.query(TRANSITION_FULFILLMENT, {
            id: fulfillmentId,
            state: 'Delivered',
        });
        expect(transitionResult.transitionFulfillmentToState.message).toBeUndefined();
        await waitForOrderState('Delivered');

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('Delivered');
        expect(actualOrder.deliveryPerson).toBeNull();
    });
});
