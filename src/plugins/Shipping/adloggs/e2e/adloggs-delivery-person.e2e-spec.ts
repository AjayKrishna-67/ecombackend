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
import { DeliveryStrategyRouterPlugin } from '../../../own-delivery-partner/delivery-strategy-router/delivery-strategy-router.plugin';
import { DeliveryReportService } from '../../../own-delivery-partner/delivery-strategy-router/services/delivery-report.service';
import { AdloggsPlugin } from '../adloggs.plugin';
import { AdloggsService } from '../services/adloggs.service';
import { AdloggsWebhookPayload } from '../types';

/**
 * End-to-end coverage for the Adloggs rider reaching the customer: a real
 * Vendure server with the delivery plugin (handler, processes, state
 * subscriber, shop `Order.deliveryPerson`) and the Adloggs plugin (create
 * subscriber, webhook controller), driven the way the admin, Adloggs and the
 * customer's app drive it.
 *
 * What this buys over the unit tests. `adloggs-mapper.spec.ts` proves Picked up
 * maps to OutforDelivery and `customer-delivery-person.spec.ts` proves which
 * fulfillment the helper reads; nothing there proves the webhook stores the
 * rider and the OTP on the fulfillment, that the fulfillment and the order
 * really walk to OutforDelivery / Delivered, that the shop field returns the
 * Adloggs rider, or that the OTP stays out of the shop's Fulfillment fields.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(process.cwd(), 'src/plugins/Shipping/adloggs/e2e/__data__');

registerInitializer('sqljs', new SqljsInitializer(dataDir));

// MySQL-only backfill at bootstrap; see order-delivery-person.e2e-spec.ts.
vi.spyOn(DeliveryReportService.prototype, 'onApplicationBootstrap').mockResolvedValue(undefined);

// ── No network ──
// Every Adloggs REST call goes through the private `post`; failing it closed
// means a call this suite did not expect (availability at checkout, cancel)
// can never leave the machine. Create is then stubbed on top of it.
const adloggsPost = vi
    .spyOn(AdloggsService.prototype as any, 'post')
    .mockResolvedValue({ status: false, code: 0, message: 'network disabled in e2e', data: {} });
const createOrder = vi.spyOn(AdloggsService.prototype, 'createOrder').mockImplementation(async payload => ({
    status: true,
    code: 200,
    message: 'ok',
    data: { order_uuid: 'uuid-1', trackUrl: '', partner_order_id: payload.partner_order_id, fee: 50, distance: 2 },
}));
// The address has no map pin custom fields in this config, so the real method
// would geocode the pincode through Nominatim.
vi.spyOn(AdloggsService.prototype, 'resolveDeliveryPoint').mockResolvedValue({
    lat: 11.0168,
    long: 76.9558,
    approximate: false,
});

// Settles immediately, so an order can be placed without a gateway.
const e2ePaymentHandler = new PaymentMethodHandler({
    code: 'e2e-pay',
    description: [{ languageCode: LanguageCode.en, value: 'e2e test payment' }],
    args: {},
    createPayment: (ctx, order, amount) => ({ amount, state: 'Settled' as const, transactionId: 'e2e' }),
    settlePayment: () => ({ success: true }),
});

const PORT = 3060;
const WEBHOOK_URL = `http://localhost:${PORT}/adloggs/webhook`;
const WEBHOOK_TOKEN = 'test-token';

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [
            DeliveryStrategyRouterPlugin,
            // Port 9 (discard) on loopback: unreachable even if a stub is missed.
            AdloggsPlugin.init({ apiHost: 'http://127.0.0.1:9', apiKey: 'test', webhookToken: WEBHOOK_TOKEN }),
        ],
        paymentOptions: { paymentMethodHandlers: [e2ePaymentHandler] },
        apiOptions: { port: PORT },
    }),
);

const RIDER = { name: 'viknesh', phone: '9090909090' };
const DELIVERY_OTP = '9243';

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
                method
                customFields {
                    adloggsOrderUuid
                    adloggsStatus
                    adloggsRiderName
                    adloggsRiderPhone
                    adloggsDeliveryOtp
                    adloggsFee
                    adloggsError
                }
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

const SET_SHIPPING_ADDRESS = gql`
    mutation SetShippingAddress($input: CreateAddressInput!) {
        setOrderShippingAddress(input: $input) {
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
                deliveryOtp
            }
            fulfillments {
                state
                customFields
            }
        }
    }
`;

const CANCEL_ORDER = gql`
    mutation CancelOrder($input: CancelOrderInput!) {
        cancelOrder(input: $input) {
            ... on Order {
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

const SYNC_ADLOGGS_STATUS = gql`
    mutation SyncAdloggsStatus($fulfillmentId: ID!) {
        syncAdloggsStatus(fulfillmentId: $fulfillmentId) {
            success
            message
            statusId
            fulfillmentState
        }
    }
`;

const VARIANT_STOCK = gql`
    query VariantStock($id: ID!) {
        productVariant(id: $id) {
            stockLevels {
                stockOnHand
                stockAllocated
            }
            stockMovements {
                totalItems
                items {
                    ... on StockMovement {
                        id
                        type
                        quantity
                    }
                }
            }
        }
    }
`;

interface ShopOrder {
    code: string;
    state: string;
    deliveryPerson: { name: string; phoneNumber: string | null; deliveryOtp: string | null } | null;
    fulfillments: Array<{ state: string; customFields: unknown }>;
}

interface AdminFulfillment {
    id: string;
    state: string;
    method: string;
    customFields: {
        adloggsOrderUuid: string | null;
        adloggsStatus: number | null;
        adloggsRiderName: string | null;
        adloggsRiderPhone: string | null;
        adloggsDeliveryOtp: string | null;
        adloggsFee: string | null;
        adloggsError: string | null;
    };
}

interface AdminOrder {
    id: string;
    state: string;
    lines: Array<{ id: string; quantity: number }>;
    fulfillments: AdminFulfillment[];
}

describe('Adloggs rider as Order.deliveryPerson on the shop API (e2e)', () => {
    let variantId: string;
    let shippingMethodId: string;
    let orderId: string;
    let orderCode: string;

    const shopOrder = async (): Promise<ShopOrder> =>
        (await shopClient.query(ORDER_BY_CODE, { code: orderCode })).orderByCode;

    const adminOrder = async (): Promise<AdminOrder> => (await adminClient.query(ADMIN_ORDER, { id: orderId })).order;

    /** Polls the admin order until `predicate` holds (subscribers run post-commit). */
    const waitForAdminOrder = async (predicate: (order: AdminOrder) => boolean, what: string) => {
        let order = await adminOrder();
        for (let attempt = 0; attempt < 50 && !predicate(order); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            order = await adminOrder();
        }
        if (!predicate(order)) {
            throw new Error(`Timed out waiting for ${what}; order is ${JSON.stringify(order)}`);
        }
        return order;
    };

    const postWebhook = async (body: Partial<AdloggsWebhookPayload>, token: string | null = WEBHOOK_TOKEN) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token !== null) {
            headers['x-webhook-token'] = token;
        }
        const response = await fetch(WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };

    /** Shape of an Adloggs status webhook, as their doc's "Assigned" sample. */
    const webhookBody = (orderStatusId: number, extra: Partial<AdloggsWebhookPayload> = {}): AdloggsWebhookPayload => ({
        order_uuid: 'uuid-1',
        order_status_id: orderStatusId,
        partner_order_id: orderCode,
        deliveryStaffDetails: {
            name: RIDER.name,
            phone: RIDER.phone,
            currentLocation: { lat: '11.0168', long: '76.9558' },
        },
        eta: { to_pickup: 5, to_delivery: 20 },
        rider_platform: { name: 'Adloggs', lsp_uniq_id: 'lsp-1' },
        reason: null,
        otps: { delivery_otp: DELIVERY_OTP, pickup_otp: '1111', return_otp: null },
        ...extra,
    });

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

        // The customer checks out with a flat-rate method; the admin dispatches
        // through Adloggs anyway, so the pickup store comes from the Adloggs
        // method on the channel (AdloggsFulfillmentService.findPickupConfig, path 2).
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

        await adminClient.query(CREATE_SHIPPING_METHOD, {
            input: {
                code: 'adloggs-store',
                translations: [{ languageCode: 'en', name: 'Adloggs' }],
                fulfillmentHandler: 'kaaikani-fulfillment',
                checker: {
                    code: 'default-shipping-eligibility-checker',
                    arguments: [{ name: 'orderMinimum', value: '0' }],
                },
                calculator: {
                    code: 'adloggs-calculator',
                    arguments: [
                        {
                            name: 'pickupConfig',
                            value: JSON.stringify({
                                name: 'KaaiKani Store',
                                phone: '9000000000',
                                address: '1 Market Road, Coimbatore',
                                lat: 11.0,
                                long: 76.95,
                                pincode: '641001',
                                city: 'Coimbatore',
                                state: 'Tamil Nadu',
                            }),
                        },
                    ],
                },
            },
        });

        const customersResult = await adminClient.query(GET_CUSTOMERS);
        await shopClient.asUserWithCredentials(customersResult.customers.items[0].emailAddress, 'test');
    }, 180_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        await server.destroy();
    });

    it('creates the Adloggs order (stubbed) when the admin fulfills with the Adloggs option', async () => {
        await shopClient.query(ADD_ITEM, { productVariantId: variantId, quantity: 2 });
        await shopClient.query(SET_SHIPPING_ADDRESS, {
            input: {
                fullName: 'Test Customer',
                streetLine1: '12 Lake View',
                city: 'Coimbatore',
                province: 'Tamil Nadu',
                postalCode: '641002',
                countryCode: 'IN',
                phoneNumber: '+91 98765 43210',
            },
        });
        await shopClient.query(SET_SHIPPING_METHOD, { ids: [shippingMethodId] });
        const transitionResult = await shopClient.query(TRANSITION_ORDER, { state: 'ArrangingPayment' });
        expect(transitionResult.transitionOrderToState.state).toBe('ArrangingPayment');
        const payResult = await shopClient.query(ADD_PAYMENT, { input: { method: 'e2e-pay', metadata: {} } });
        expect(payResult.addPaymentToOrder.state).toBe('PaymentSettled');
        orderId = payResult.addPaymentToOrder.id;
        orderCode = payResult.addPaymentToOrder.code;

        const order = await adminOrder();
        const fulfillResult = await adminClient.query(ADD_FULFILLMENT, {
            input: {
                lines: order.lines.map(l => ({ orderLineId: l.id, quantity: l.quantity })),
                handler: {
                    code: 'kaaikani-fulfillment',
                    arguments: [{ name: 'fulfillmentConfig', value: JSON.stringify({ type: 'adloggs' }) }],
                },
            },
        });
        expect(fulfillResult.addFulfillmentToOrder.message).toBeUndefined();
        expect(fulfillResult.addFulfillmentToOrder.state).toBe('Pending');

        // The create call runs in a post-commit subscriber.
        const actualOrder = await waitForAdminOrder(
            o => !!o.fulfillments[0]?.customFields.adloggsOrderUuid || !!o.fulfillments[0]?.customFields.adloggsError,
            'the Adloggs create subscriber',
        );

        expect(createOrder).toHaveBeenCalledTimes(1);
        expect(createOrder.mock.calls[0][0]).toMatchObject({
            partner_order_id: orderCode,
            pickup_contact_name: 'KaaiKani Store',
            delivery_contact_no: '9876543210',
            payment_type: 'Online',
            collectible_amount: 0,
        });
        // We pick the delivery OTP, send it on create and keep it, so the
        // customer has one even if no webhook ever arrives.
        const sentOtp = createOrder.mock.calls[0][0].delivery_otp;
        expect(sentOtp).toBeGreaterThanOrEqual(1000);
        expect(sentOtp).toBeLessThanOrEqual(9999);
        expect(actualOrder.state).toBe('PaymentSettled');
        expect(actualOrder.fulfillments).toHaveLength(1);
        expect(actualOrder.fulfillments[0]).toMatchObject({
            state: 'Pending',
            method: 'Adloggs',
            customFields: {
                adloggsOrderUuid: 'uuid-1',
                adloggsStatus: 2,
                adloggsFee: '50',
                adloggsError: '',
                adloggsRiderName: null,
                adloggsDeliveryOtp: String(sentOtp),
            },
        });
    });

    it('stores the rider and OTP on Assigned, but the customer sees nobody before pickup', async () => {
        const webhookResult = await postWebhook(webhookBody(3));

        expect(webhookResult).toEqual({ status: 200, body: { success: true, message: 'Adloggs status: Assigned' } });
        const order = await adminOrder();
        expect(order.state).toBe('PaymentSettled');
        expect(order.fulfillments[0]).toMatchObject({
            state: 'Pending',
            customFields: {
                adloggsStatus: 3,
                adloggsRiderName: RIDER.name,
                adloggsRiderPhone: RIDER.phone,
                adloggsDeliveryOtp: DELIVERY_OTP,
            },
        });

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('PaymentSettled');
        expect(actualOrder.deliveryPerson).toBeNull();
    });

    it('ships the order on Picked up and shows the Adloggs rider with the OTP', async () => {
        // Picked up is not out for delivery: the order is Shipped, but the
        // customer already sees who has it. A later webhook without the OTP
        // must not wipe the one already stored.
        const webhookResult = await postWebhook(
            webhookBody(4, { otps: { delivery_otp: null, pickup_otp: null, return_otp: null } }),
        );

        expect(webhookResult).toEqual({ status: 200, body: { success: true, message: 'Adloggs status: Picked up' } });
        const order = await waitForAdminOrder(o => o.state === 'Shipped', 'order → Shipped');
        expect(order.fulfillments[0]).toMatchObject({
            state: 'Shipped',
            customFields: { adloggsStatus: 4, adloggsDeliveryOtp: DELIVERY_OTP },
        });

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('Shipped');
        expect(actualOrder.deliveryPerson).toEqual({
            name: RIDER.name,
            phoneNumber: RIDER.phone,
            deliveryOtp: DELIVERY_OTP,
        });
    });

    it('does not leak the Adloggs fields (OTP, rider, uuid) through the shop Fulfillment', async () => {
        const actualOrder = await shopOrder();

        expect(actualOrder.fulfillments).toHaveLength(1);
        expect(actualOrder.fulfillments[0].state).toBe('Shipped');
        expect(actualOrder.fulfillments[0].customFields).toBeNull();
    });

    it('shows the new rider when Adloggs reassigns the order after pickup', async () => {
        const webhookResult = await postWebhook(
            webhookBody(4, {
                deliveryStaffDetails: { name: 'Mani', phone: '9123456789', currentLocation: {} },
                otps: { delivery_otp: '5678', pickup_otp: null, return_otp: null },
            }),
        );

        expect(webhookResult.status).toBe(200);
        expect((await shopOrder()).deliveryPerson).toEqual({
            name: 'Mani',
            phoneNumber: '9123456789',
            deliveryOtp: '5678',
        });
    });

    it('ignores a late, older webhook carrying the previous rider', async () => {
        // An "Assigned" sent before pickup but delivered after it must not
        // bring back the rider the order was taken away from.
        const webhookResult = await postWebhook(webhookBody(3));

        expect(webhookResult.status).toBe(200);
        expect((await shopOrder()).deliveryPerson).toEqual({
            name: 'Mani',
            phoneNumber: '9123456789',
            deliveryOtp: '5678',
        });
    });

    it('takes the rider from a manual Sync even when Adloggs reports an earlier status', async () => {
        // getcurrentstatus is Adloggs' view right now, so its rider is current
        // whatever status it reports; the status itself still never goes back.
        const getCurrentStatus = vi.spyOn(AdloggsService.prototype, 'getCurrentStatus').mockResolvedValueOnce({
            status: true,
            code: 200,
            message: 'Success',
            data: {
                order_uuid: 'uuid-1',
                order_status_id: 3,
                is_return: false,
                deliveryStaffDetails: { name: 'karuppasamy', phone: '9000011111', currentLocation: {} },
            },
        });
        const fulfillmentId = (await adminOrder()).fulfillments[0].id;

        const result = await adminClient.query(SYNC_ADLOGGS_STATUS, { fulfillmentId });

        expect(getCurrentStatus).toHaveBeenCalledTimes(1);
        expect(result.syncAdloggsStatus.success).toBe(true);
        const order = await adminOrder();
        expect(order.fulfillments[0]).toMatchObject({ state: 'Shipped', customFields: { adloggsStatus: 4 } });
        expect((await shopOrder()).deliveryPerson).toEqual({
            name: 'karuppasamy',
            phoneNumber: '9000011111',
            deliveryOtp: '5678',
        });
        getCurrentStatus.mockRestore();
    });

    it('keeps showing the rider once the order is out for delivery', async () => {
        const webhookResult = await postWebhook(webhookBody(9, { deliveryStaffDetails: undefined, otps: undefined }));

        expect(webhookResult.status).toBe(200);
        const order = await waitForAdminOrder(o => o.state === 'OutforDelivery', 'order → OutforDelivery');
        expect(order.fulfillments[0]).toMatchObject({ state: 'OutforDelivery', customFields: { adloggsStatus: 9 } });
        expect((await shopOrder()).deliveryPerson).toEqual({
            name: 'karuppasamy',
            phoneNumber: '9000011111',
            deliveryOtp: '5678',
        });
    });

    it('delivers the order on Delivered and the customer sees nobody any more', async () => {
        const webhookResult = await postWebhook(webhookBody(5));

        expect(webhookResult).toEqual({ status: 200, body: { success: true, message: 'Adloggs status: Delivered' } });
        const order = await waitForAdminOrder(o => o.state === 'Delivered', 'order → Delivered');
        expect(order.fulfillments[0]).toMatchObject({ state: 'Delivered', customFields: { adloggsStatus: 5 } });

        const actualOrder = await shopOrder();

        expect(actualOrder.state).toBe('Delivered');
        expect(actualOrder.deliveryPerson).toBeNull();
    });

    it('rejects a webhook with a bad or missing token and changes nothing', async () => {
        const before = await adminOrder();
        // With a good token this status would be applied (Cancelled ranks equal
        // to Delivered, so it is not "stale") and overwrite rider and OTP.
        const forged = webhookBody(6, {
            deliveryStaffDetails: { name: 'intruder', phone: '9999999999' },
            otps: { delivery_otp: '0000' },
        });

        const badToken = await postWebhook(forged, 'wrong-token');
        const noToken = await postWebhook(forged, null);

        expect(badToken).toEqual({ status: 401, body: { success: false, error: 'Invalid token' } });
        expect(noToken).toEqual({ status: 401, body: { success: false, error: 'Invalid token' } });
        const after = await adminOrder();
        expect(after).toEqual(before);
        expect(after.fulfillments[0].customFields).toMatchObject({
            adloggsStatus: 5,
            adloggsRiderName: RIDER.name,
            adloggsDeliveryOtp: DELIVERY_OTP,
        });
        expect((await shopOrder()).state).toBe('Delivered');
    });

    it('never called any other Adloggs endpoint', () => {
        expect(adloggsPost).not.toHaveBeenCalled();
    });

    /**
     * Cancellation against Adloggs, on the same server: each case places its
     * own order (with its own Adloggs uuid) for a variant that tracks stock, so
     * a second stock release would show up in the variant's levels.
     */
    describe('cancelling an Adloggs-dispatched order', () => {
        let stockedVariantId: string;
        const cancelOrderSpy = vi.spyOn(AdloggsService.prototype, 'cancelOrder');

        const adminOrderById = async (id: string): Promise<AdminOrder> =>
            (await adminClient.query(ADMIN_ORDER, { id })).order;

        const waitForOrder = async (id: string, predicate: (order: AdminOrder) => boolean, what: string) => {
            let order = await adminOrderById(id);
            for (let attempt = 0; attempt < 50 && !predicate(order); attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                order = await adminOrderById(id);
            }
            if (!predicate(order)) {
                throw new Error(`Timed out waiting for ${what}; order is ${JSON.stringify(order)}`);
            }
            return order;
        };

        const variantStock = async () => {
            const variant = (await adminClient.query(VARIANT_STOCK, { id: stockedVariantId })).productVariant;
            return {
                stockOnHand: variant.stockLevels[0].stockOnHand as number,
                stockAllocated: variant.stockLevels[0].stockAllocated as number,
                movements: variant.stockMovements.items as Array<{ id: string; type: string; quantity: number }>,
            };
        };

        /** Places a paid order and fulfills it via Adloggs; waits for the create subscriber. */
        const placeAdloggsOrder = async (): Promise<{ id: string; code: string; fulfillment: AdminFulfillment }> => {
            const added = await shopClient.query(ADD_ITEM, { productVariantId: stockedVariantId, quantity: 2 });
            expect(added.addItemToOrder.message).toBeUndefined();
            await shopClient.query(SET_SHIPPING_ADDRESS, {
                input: {
                    fullName: 'Test Customer',
                    streetLine1: '12 Lake View',
                    city: 'Coimbatore',
                    province: 'Tamil Nadu',
                    postalCode: '641002',
                    countryCode: 'IN',
                    phoneNumber: '+91 98765 43210',
                },
            });
            await shopClient.query(SET_SHIPPING_METHOD, { ids: [shippingMethodId] });
            await shopClient.query(TRANSITION_ORDER, { state: 'ArrangingPayment' });
            const payResult = await shopClient.query(ADD_PAYMENT, { input: { method: 'e2e-pay', metadata: {} } });
            expect(payResult.addPaymentToOrder.state).toBe('PaymentSettled');
            const { id, code } = payResult.addPaymentToOrder;

            const placed = await adminOrderById(id);
            const fulfillResult = await adminClient.query(ADD_FULFILLMENT, {
                input: {
                    lines: placed.lines.map(l => ({ orderLineId: l.id, quantity: l.quantity })),
                    handler: {
                        code: 'kaaikani-fulfillment',
                        arguments: [{ name: 'fulfillmentConfig', value: JSON.stringify({ type: 'adloggs' }) }],
                    },
                },
            });
            expect(fulfillResult.addFulfillmentToOrder.state).toBe('Pending');

            const order = await waitForOrder(
                id,
                o => !!o.fulfillments[0]?.customFields.adloggsOrderUuid || !!o.fulfillments[0]?.customFields.adloggsError,
                'the Adloggs create subscriber',
            );
            return { id, code, fulfillment: order.fulfillments[0] };
        };

        const nextCreateReturnsUuid = (uuid: string) =>
            createOrder.mockImplementationOnce(async payload => ({
                status: true,
                code: 200,
                message: 'ok',
                data: { order_uuid: uuid, trackUrl: '', partner_order_id: payload.partner_order_id, fee: 50, distance: 2 },
            }));

        const assignRider = async (uuid: string, code: string) => {
            const result = await postWebhook(webhookBody(3, { order_uuid: uuid, partner_order_id: code }));
            expect(result.body).toEqual({ success: true, message: 'Adloggs status: Assigned' });
        };

        const adminCancel = async (orderId: string) => {
            const result = await adminClient.query(CANCEL_ORDER, { input: { orderId, reason: 'customer asked' } });
            expect(result.cancelOrder.message).toBeUndefined();
            expect(result.cancelOrder.state).toBe('Cancelled');
        };

        beforeAll(async () => {
            const productResult = await adminClient.query(CREATE_PRODUCT, {
                input: {
                    translations: [{ languageCode: 'en', name: 'Beans 1kg', slug: 'beans', description: 'Beans' }],
                },
            });
            const variantResult = await adminClient.query(CREATE_VARIANTS, {
                input: [
                    {
                        productId: productResult.createProduct.id,
                        sku: 'BEANS',
                        price: 8000,
                        trackInventory: 'TRUE',
                        stockOnHand: 100,
                        translations: [{ languageCode: 'en', name: 'Beans 1kg' }],
                    },
                ],
            });
            stockedVariantId = variantResult.createProductVariants[0].id;
        });

        describe('Adloggs refuses the cancel ("Order already picked up.")', () => {
            let order: { id: string; code: string; fulfillment: AdminFulfillment };

            beforeAll(async () => {
                nextCreateReturnsUuid('uuid-picked');
                order = await placeAdloggsOrder();
                expect(order.fulfillment.customFields.adloggsOrderUuid).toBe('uuid-picked');
                await assignRider('uuid-picked', order.code);
            });

            it('keeps the Adloggs status and shows the refusal on the fulfillment', async () => {
                cancelOrderSpy.mockResolvedValueOnce({
                    status: false,
                    code: 202,
                    message: 'Order already picked up.',
                    data: {},
                });

                await adminCancel(order.id);

                // The cancel call runs in the post-commit order-cancel subscriber.
                const actual = await waitForOrder(
                    order.id,
                    o => !!o.fulfillments[0]?.customFields.adloggsError,
                    'the Adloggs cancel subscriber',
                );
                expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
                expect(cancelOrderSpy.mock.calls[0][0]).toBe('uuid-picked');
                expect(actual.state).toBe('Cancelled');
                expect(actual.fulfillments[0].customFields).toMatchObject({
                    adloggsError: 'Cancel refused by Adloggs: Order already picked up.',
                    adloggsStatus: 3,
                });
            });

            it('does not cancel the fulfillment (or release stock again) when Adloggs later reports Cancelled', async () => {
                const before = await adminOrderById(order.id);
                const stockBefore = await variantStock();
                expect(before.state).toBe('Cancelled');

                const webhookResult = await postWebhook(
                    webhookBody(6, { order_uuid: 'uuid-picked', partner_order_id: order.code }),
                );

                expect(webhookResult).toEqual({ status: 200, body: { success: true, message: 'Adloggs status: Cancelled' } });
                const after = await adminOrderById(order.id);
                expect(after.state).toBe('Cancelled');
                expect(after.fulfillments[0].state).toBe(before.fulfillments[0].state);
                expect(after.fulfillments[0].state).not.toBe('Cancelled');
                expect(after.fulfillments[0].customFields.adloggsStatus).toBe(6);
                expect(await variantStock()).toEqual(stockBefore);
                // No transition, so no fulfillment-cancel subscriber echoing back to Adloggs.
                await new Promise(resolve => setTimeout(resolve, 300));
                expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
            });
        });

        describe('Adloggs answers "Order already cancelled."', () => {
            it('treats the refusal as a successful cancel', async () => {
                nextCreateReturnsUuid('uuid-gone');
                const order = await placeAdloggsOrder();
                await assignRider('uuid-gone', order.code);
                cancelOrderSpy.mockClear();
                cancelOrderSpy.mockResolvedValueOnce({
                    status: false,
                    code: 202,
                    message: 'Order already cancelled.',
                    data: {},
                });

                await adminCancel(order.id);

                const actual = await waitForOrder(
                    order.id,
                    o => o.fulfillments[0]?.customFields.adloggsStatus === 6,
                    'the Adloggs cancel subscriber',
                );
                expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
                expect(cancelOrderSpy.mock.calls[0][0]).toBe('uuid-gone');
                expect(actual.fulfillments[0].customFields.adloggsError).toBeFalsy();
            });
        });

        describe('sync on a cancelled order whose Adloggs order was never created', () => {
            it('refuses to create an Adloggs order now', async () => {
                createOrder.mockResolvedValueOnce({ status: false, code: 500, message: 'Internal error', data: {} as any });
                const order = await placeAdloggsOrder();
                expect(order.fulfillment.customFields.adloggsOrderUuid).toBeFalsy();
                expect(order.fulfillment.customFields.adloggsError).toContain('Internal error');
                cancelOrderSpy.mockClear();
                await adminCancel(order.id);
                const createCallsBefore = createOrder.mock.calls.length;

                const result = await adminClient.query(SYNC_ADLOGGS_STATUS, { fulfillmentId: order.fulfillment.id });

                expect(result.syncAdloggsStatus.success).toBe(false);
                expect(result.syncAdloggsStatus.message).toMatch(/^Not creating an Adloggs order/);
                expect(createOrder).toHaveBeenCalledTimes(createCallsBefore);
                // No uuid, so the order-cancel subscriber had nothing to cancel either.
                expect(cancelOrderSpy).not.toHaveBeenCalled();
                const after = await adminOrderById(order.id);
                expect(after.fulfillments[0].customFields.adloggsOrderUuid).toBeFalsy();
            });
        });

        it('still never reached the network', () => {
            expect(adloggsPost).not.toHaveBeenCalled();
        });
    });
});
