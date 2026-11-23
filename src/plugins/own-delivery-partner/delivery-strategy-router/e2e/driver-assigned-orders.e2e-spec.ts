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
 * End-to-end coverage for `driverAssignedOrders` — the fleet detail page's
 * "assigned orders" list. A real Vendure server runs the query against real
 * fulfillments, so the joins, the internal custom-field columns and the
 * "held during the range" window are all exercised, not mocked.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(
    process.cwd(),
    'src/plugins/own-delivery-partner/delivery-strategy-router/e2e/__data__',
);

registerInitializer('sqljs', new SqljsInitializer(dataDir));

// MySQL-only bootstrap backfill — see order-delivery-person.e2e-spec.ts.
vi.spyOn(DeliveryReportService.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);

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
        customFields: { Administrator: customFields!.Administrator },
        apiOptions: { port: 3060 },
    }),
);

const DRIVER_ASSIGNED_ORDERS = gql`
    query DriverAssignedOrders($deliveryPersonId: ID!, $dateFrom: DateTime!, $dateTo: DateTime!) {
        driverAssignedOrders(deliveryPersonId: $deliveryPersonId, dateFrom: $dateFrom, dateTo: $dateTo) {
            fulfillmentId
            orderId
            orderCode
            state
            assignedAt
            deliveredAt
            customerName
            area
            orderTotal
        }
    }
`;

const ADMIN_ORDER = gql`
    query AdminOrder($id: ID!) {
        order(id: $id) {
            id
            lines {
                id
                quantity
            }
        }
    }
`;

const ADD_FULFILLMENT = gql`
    mutation AddFulfillment($input: FulfillOrderInput!) {
        addFulfillmentToOrder(input: $input) {
            ... on Fulfillment {
                id
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

interface AssignedOrder {
    fulfillmentId: string;
    orderId: string;
    orderCode: string;
    state: string;
    assignedAt: string;
    deliveredAt: string | null;
    customerName: string | null;
    area: string | null;
    orderTotal: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The handler's arg is raw JSON, so the id inside it is the database id. */
const databaseId = (id: string) => id.replace(/^T_/, '');

describe('driverAssignedOrders (e2e)', () => {
    let variantId: string;
    let shippingMethodId: string;
    let riderId: string;
    let otherRiderId: string;
    /** Delivered during the test. */
    let delivered: { id: string; code: string; fulfillmentId: string };
    /** Stays assigned (Shipped). */
    let open: { id: string; code: string; fulfillmentId: string };

    const assigned = async (deliveryPersonId: string, from: Date, to: Date): Promise<AssignedOrder[]> =>
        (
            await adminClient.query(DRIVER_ASSIGNED_ORDERS, {
                deliveryPersonId,
                dateFrom: from.toISOString(),
                dateTo: to.toISOString(),
            })
        ).driverAssignedOrders;

    /** Today's window, padded so the clock moving during the test can't matter. */
    const today = () => ({ from: new Date(Date.now() - DAY_MS / 2), to: new Date(Date.now() + DAY_MS / 2) });

    const placeOrder = async (address?: { fullName: string; city: string }) => {
        await shopClient.query(
            gql`
                mutation AddItem($productVariantId: ID!, $quantity: Int!) {
                    addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
                        ... on Order {
                            id
                        }
                    }
                }
            `,
            { productVariantId: variantId, quantity: 2 },
        );
        if (address) {
            await shopClient.query(
                gql`
                    mutation SetAddress($input: CreateAddressInput!) {
                        setOrderShippingAddress(input: $input) {
                            ... on Order {
                                id
                            }
                        }
                    }
                `,
                { input: { ...address, streetLine1: '1 Main St', countryCode: 'IN' } },
            );
        }
        await shopClient.query(
            gql`
                mutation SetShippingMethod($ids: [ID!]!) {
                    setOrderShippingMethod(shippingMethodId: $ids) {
                        ... on Order {
                            id
                        }
                    }
                }
            `,
            { ids: [shippingMethodId] },
        );
        await shopClient.query(gql`
            mutation {
                transitionOrderToState(state: "ArrangingPayment") {
                    ... on Order {
                        id
                    }
                }
            }
        `);
        const payResult = await shopClient.query(gql`
            mutation {
                addPaymentToOrder(input: { method: "e2e-pay", metadata: {} }) {
                    ... on Order {
                        id
                        code
                        state
                    }
                }
            }
        `);
        expect(payResult.addPaymentToOrder.state).toBe('PaymentSettled');
        return { id: payResult.addPaymentToOrder.id as string, code: payResult.addPaymentToOrder.code as string };
    };

    /** Assign the whole order to the rider, then ship it (see order-delivery-person.e2e-spec.ts). */
    const assignToRider = async (orderId: string): Promise<string> => {
        const order = (await adminClient.query(ADMIN_ORDER, { id: orderId })).order;
        const fulfillResult = await adminClient.query(ADD_FULFILLMENT, {
            input: {
                lines: order.lines.map((l: { id: string; quantity: number }) => ({
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
        const fulfillmentId = fulfillResult.addFulfillmentToOrder.id;
        const shipResult = await adminClient.query(TRANSITION_FULFILLMENT, { id: fulfillmentId, state: 'Shipped' });
        expect(shipResult.transitionFulfillmentToState.state).toBe('Shipped');
        return fulfillmentId;
    };

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 1 });
        await adminClient.asSuperAdmin();

        const productResult = await adminClient.query(
            gql`
                mutation CreateProduct($input: CreateProductInput!) {
                    createProduct(input: $input) {
                        id
                    }
                }
            `,
            {
                input: {
                    translations: [{ languageCode: 'en', name: 'Carrot 1kg', slug: 'carrot', description: 'Carrot' }],
                },
            },
        );
        const variantResult = await adminClient.query(
            gql`
                mutation CreateVariants($input: [CreateProductVariantInput!]!) {
                    createProductVariants(input: $input) {
                        id
                    }
                }
            `,
            {
                input: [
                    {
                        productId: productResult.createProduct.id,
                        sku: 'CARROT',
                        price: 10000,
                        trackInventory: 'FALSE',
                        translations: [{ languageCode: 'en', name: 'Carrot 1kg' }],
                    },
                ],
            },
        );
        variantId = variantResult.createProductVariants[0].id;

        await adminClient.query(
            gql`
                mutation CreatePaymentMethod($input: CreatePaymentMethodInput!) {
                    createPaymentMethod(input: $input) {
                        id
                    }
                }
            `,
            {
                input: {
                    code: 'e2e-pay',
                    enabled: true,
                    handler: { code: 'e2e-pay', arguments: [] },
                    translations: [{ languageCode: 'en', name: 'e2e test payment' }],
                },
            },
        );

        const shippingResult = await adminClient.query(
            gql`
                mutation CreateShippingMethod($input: CreateShippingMethodInput!) {
                    createShippingMethod(input: $input) {
                        id
                    }
                }
            `,
            {
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
            },
        );
        shippingMethodId = shippingResult.createShippingMethod.id;

        const roleResult = await adminClient.query(
            gql`
                mutation CreateRole($input: CreateRoleInput!) {
                    createRole(input: $input) {
                        id
                    }
                }
            `,
            {
                input: {
                    code: 'delivery-person',
                    description: 'Delivery person',
                    permissions: ['TransitionToOutForDelivery', 'TransitionToDelivered'],
                },
            },
        );
        const createRider = async (firstName: string, emailAddress: string): Promise<string> =>
            (
                await adminClient.query(
                    gql`
                        mutation CreateAdministrator($input: CreateAdministratorInput!) {
                            createAdministrator(input: $input) {
                                id
                            }
                        }
                    `,
                    {
                        input: {
                            firstName,
                            lastName: 'Rider',
                            emailAddress,
                            password: 'rider-password',
                            roleIds: [roleResult.createRole.id],
                            customFields: { phoneNumber: '9876543210' },
                        },
                    },
                )
            ).createAdministrator.id;
        riderId = await createRider('Ravi', 'ravi@example.com');
        otherRiderId = await createRider('Mani', 'mani@example.com');

        const customersResult = await adminClient.query(gql`
            query {
                customers(options: { take: 1 }) {
                    items {
                        emailAddress
                    }
                }
            }
        `);
        await shopClient.asUserWithCredentials(customersResult.customers.items[0].emailAddress, 'test');

        const deliveredOrder = await placeOrder({ fullName: 'Priya', city: 'Madurai' });
        delivered = { ...deliveredOrder, fulfillmentId: await assignToRider(deliveredOrder.id) };
        const openOrder = await placeOrder();
        open = { ...openOrder, fulfillmentId: await assignToRider(openOrder.id) };
    }, 180_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        await server.destroy();
    });

    it("lists the rider's assignments of the day, one row per fulfillment, newest first", async () => {
        const { from, to } = today();

        const actual = await assigned(riderId, from, to);

        expect(actual.map(o => [o.orderCode, o.state])).toEqual([
            [open.code, 'Shipped'],
            [delivered.code, 'Shipped'],
        ]);
        const first = actual[1];
        expect(first.fulfillmentId).toBe(delivered.fulfillmentId);
        expect(first.orderId).toBe(delivered.id);
        expect(first.customerName).toBe('Priya');
        expect(first.area).toBe('Madurai');
        // 2 × ₹100 + ₹50 shipping, in paise
        expect(first.orderTotal).toBe(25000);
        expect(first.deliveredAt).toBeNull();
        // No shipping address set: falls back to the customer's own name
        expect(actual[0].customerName).toBeTruthy();
    });

    it('marks a delivered assignment with its delivery time', async () => {
        for (const state of ['OutforDelivery', 'Delivered']) {
            const result = await adminClient.query(TRANSITION_FULFILLMENT, { id: delivered.fulfillmentId, state });
            expect(result.transitionFulfillmentToState.state).toBe(state);
        }
        const { from, to } = today();

        const actual = await assigned(riderId, from, to);

        const row = actual.find(o => o.orderCode === delivered.code)!;
        expect(row.state).toBe('Delivered');
        expect(row.deliveredAt).not.toBeNull();
        expect(actual.find(o => o.orderCode === open.code)!.state).toBe('Shipped');
    });

    it('leaves out everything assigned after the range ends', async () => {
        const yesterday = new Date(Date.now() - DAY_MS);

        const actual = await assigned(riderId, new Date(yesterday.getTime() - DAY_MS), yesterday);

        expect(actual).toEqual([]);
    });

    it('carries a still-open assignment into a later day, but not one already delivered', async () => {
        const tomorrow = new Date(Date.now() + DAY_MS);

        const actual = await assigned(riderId, tomorrow, new Date(tomorrow.getTime() + DAY_MS));

        expect(actual.map(o => o.orderCode)).toEqual([open.code]);
    });

    it("shows nothing for a rider who wasn't assigned these orders", async () => {
        const { from, to } = today();

        expect(await assigned(otherRiderId, from, to)).toEqual([]);
    });
});
