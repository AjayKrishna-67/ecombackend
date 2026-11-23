import { LanguageCode, mergeConfig, PaymentMethodHandler } from '@vendure/core';
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
import { PICKUP_TIME_NO_METHOD_ERROR } from '../order-pickup-time.validator';
import { PICKUP_SLOT_INCOMPLETE_ERROR, PICKUP_SLOT_ORDER_ERROR, PICKUP_TIME_OUTSIDE_ERROR } from '../pickup-slot';
import { PICKUP_TIME_REQUIRED_ERROR } from '../take-away-pickup-time.process';
import { TakeAwayPlugin } from '../take-away.plugin';

/**
 * End-to-end coverage for Take Away pickup hours and the customer's pickup
 * time: a real Vendure server driven through the Admin and Shop APIs the way
 * the admin and the app drive it, through to a placed order.
 *
 * What this buys over `pickup-slot.spec.ts`. The unit tests prove the time
 * checks; nothing there proves that Vendure accepts the struct field, that
 * the storefront sees the hours on the shipping quote, that the field
 * validator runs on `setOrderCustomFields`, that the order process blocks
 * payment, that switching methods clears the time, or that the snapshot
 * service copies the hours onto the order when it is placed.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(process.cwd(), 'src/plugins/Shipping/take-away/e2e/__data__');

registerInitializer('sqljs', new SqljsInitializer(dataDir));

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
        plugins: [TakeAwayPlugin],
        paymentOptions: { paymentMethodHandlers: [e2ePaymentHandler] },
        apiOptions: { port: 3058 },
    }),
);

const HOURS = { from: '10:00 AM', to: '12:00 PM' };

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
            code
            customFields {
                pickupSlot {
                    from
                    to
                }
            }
        }
    }
`;

const UPDATE_SHIPPING_METHOD = gql`
    mutation UpdateShippingMethod($input: UpdateShippingMethodInput!) {
        updateShippingMethod(input: $input) {
            id
            customFields {
                pickupSlot {
                    from
                    to
                }
            }
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

const ADD_ITEM = gql`
    mutation AddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ... on Order {
                id
                code
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const SET_CUSTOMER = gql`
    mutation SetCustomer($input: CreateCustomerInput!) {
        setCustomerForOrder(input: $input) {
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

const ELIGIBLE_METHODS = gql`
    query EligibleMethods {
        eligibleShippingMethods {
            id
            code
            customFields {
                storeLatitude
                pickupSlot {
                    from
                    to
                }
            }
        }
    }
`;

const SET_SHIPPING_METHOD = gql`
    mutation SetShippingMethod($ids: [ID!]!) {
        setOrderShippingMethod(shippingMethodId: $ids) {
            ... on Order {
                id
                customFields {
                    pickupTime
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const SET_PICKUP_TIME = gql`
    mutation SetPickupTime($input: UpdateOrderInput!) {
        setOrderCustomFields(input: $input) {
            ... on Order {
                id
                customFields {
                    pickupTime
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const TRANSITION = gql`
    mutation Transition($state: String!) {
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
            customFields {
                isTakeAway
                pickupAddress
                pickupTime
                pickupSlot {
                    from
                    to
                }
            }
        }
    }
`;

interface PlacedOrderSnapshot {
    isTakeAway: boolean;
    pickupAddress: string | null;
    pickupTime: string | null;
    pickupSlot: { from: string | null; to: string | null } | null;
}

describe('Take Away pickup hours and pickup time (e2e)', () => {
    let variantId: string;
    let pickupMethodId: string;
    let pickupWithoutHoursMethodId: string;
    let deliveryMethodId: string;

    const pickupMethodInput = (code: string, pickupSlot?: { from: string | null; to: string | null }) => ({
        code,
        translations: [{ languageCode: 'en', name: code }],
        fulfillmentHandler: 'manual-fulfillment',
        checker: {
            code: 'default-shipping-eligibility-checker',
            arguments: [{ name: 'orderMinimum', value: '0' }],
        },
        calculator: { code: 'take-away-calculator', arguments: [{ name: 'storeLocation', value: '' }] },
        customFields: {
            storeAddress: '1 Market Street',
            storeLatitude: 9.93,
            storeLongitude: 78.12,
            ...(pickupSlot ? { pickupSlot } : {}),
        },
    });

    const setPickupTime = (pickupTime: string | null) =>
        shopClient.query(SET_PICKUP_TIME, { input: { customFields: { pickupTime } } });

    /** A cart with one line and a guest customer, ready for a shipping method. */
    const startOrder = async () => {
        const addResult = await shopClient.query(ADD_ITEM, { productVariantId: variantId, quantity: 1 });
        expect(addResult.addItemToOrder.message).toBeUndefined();
        await shopClient.query(SET_CUSTOMER, {
            input: { emailAddress: 'pickup@example.com', firstName: 'Pick', lastName: 'Up' },
        });
    };

    /** Move to payment, pay, and return the placed order's snapshot fields. */
    const placeOrder = async (): Promise<PlacedOrderSnapshot> => {
        const transitionResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });
        expect(transitionResult.transitionOrderToState.state).toBe('ArrangingPayment');
        const payResult = await shopClient.query(ADD_PAYMENT, { input: { method: 'e2e-pay', metadata: {} } });
        expect(payResult.addPaymentToOrder.state).toBe('PaymentSettled');
        const code: string = payResult.addPaymentToOrder.code;

        // The snapshot is written by an OrderPlacedEvent subscriber, after the
        // placing mutation returns, so give it a moment.
        for (let attempt = 0; attempt < 20; attempt++) {
            const result = await shopClient.query(ORDER_BY_CODE, { code });
            const customFields = result.orderByCode.customFields;
            if (customFields.isTakeAway || attempt === 19) {
                return customFields;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error('unreachable');
    };

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
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

        const deliveryResult = await adminClient.query(CREATE_SHIPPING_METHOD, {
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
                        { name: 'rate', value: '5000' },
                        { name: 'includesTax', value: 'auto' },
                        { name: 'taxRate', value: '0' },
                    ],
                },
            },
        });
        deliveryMethodId = deliveryResult.createShippingMethod.id;
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    describe('admin configuration', () => {
        it('rejects hours that end before they start', async () => {
            await expect(
                adminClient.query(CREATE_SHIPPING_METHOD, {
                    input: pickupMethodInput('bad-pickup', { from: '12:00 PM', to: '10:00 AM' }),
                }),
            ).rejects.toThrow(PICKUP_SLOT_ORDER_ERROR);
        });

        it('rejects hours with only one end set', async () => {
            await expect(
                adminClient.query(CREATE_SHIPPING_METHOD, {
                    input: pickupMethodInput('half-pickup', { from: '10:00 AM', to: null }),
                }),
            ).rejects.toThrow(PICKUP_SLOT_INCOMPLETE_ERROR);
        });

        it('stores the hours on the pickup method', async () => {
            const actualResult = await adminClient.query(CREATE_SHIPPING_METHOD, {
                input: pickupMethodInput('take-away', HOURS),
            });
            expect(actualResult.createShippingMethod.customFields.pickupSlot).toEqual(HOURS);
            pickupMethodId = actualResult.createShippingMethod.id;

            const noHoursResult = await adminClient.query(CREATE_SHIPPING_METHOD, {
                input: pickupMethodInput('take-away-no-hours'),
            });
            expect(noHoursResult.createShippingMethod.customFields.pickupSlot).toEqual({ from: null, to: null });
            pickupWithoutHoursMethodId = noHoursResult.createShippingMethod.id;
        });

        it('accepts the empty shape the editor writes to clear the hours', async () => {
            // updateShippingMethod replaces the whole customFields object, so
            // every field is sent, exactly as the admin form does.
            const updateInput = (pickupSlot: { from: string | null; to: string | null }) => ({
                id: pickupMethodId,
                translations: [{ languageCode: 'en', name: 'take-away' }],
                customFields: pickupMethodInput('take-away', pickupSlot).customFields,
            });
            const actualResult = await adminClient.query(UPDATE_SHIPPING_METHOD, {
                input: updateInput({ from: null, to: null }),
            });
            expect(actualResult.updateShippingMethod.customFields.pickupSlot).toEqual({ from: null, to: null });

            // Put the hours back for the checkout tests.
            const restored = await adminClient.query(UPDATE_SHIPPING_METHOD, {
                input: updateInput(HOURS),
            });
            expect(restored.updateShippingMethod.customFields.pickupSlot).toEqual(HOURS);
        });
    });

    describe('customer checkout', () => {
        it('shows the hours to the storefront on the shipping quote', async () => {
            await startOrder();

            const actualResult = await shopClient.query(ELIGIBLE_METHODS);

            const pickupQuote = actualResult.eligibleShippingMethods.find((m: any) => m.id === pickupMethodId);
            expect(pickupQuote.customFields.pickupSlot).toEqual(HOURS);
            expect(pickupQuote.customFields.storeLatitude).toBe(9.93);
        });

        it('refuses a time before a pickup method is selected', async () => {
            await expect(setPickupTime('10:30 AM')).rejects.toThrow(PICKUP_TIME_NO_METHOD_ERROR);
        });

        it('refuses a time outside the hours, or malformed', async () => {
            const setResult = await shopClient.query(SET_SHIPPING_METHOD, { ids: [pickupMethodId] });
            expect(setResult.setOrderShippingMethod.message).toBeUndefined();

            await expect(setPickupTime('9:45 AM')).rejects.toThrow(PICKUP_TIME_OUTSIDE_ERROR);
            await expect(setPickupTime('12:15 PM')).rejects.toThrow(PICKUP_TIME_OUTSIDE_ERROR);
            await expect(setPickupTime('10am')).rejects.toThrow();
        });

        it('blocks the move to payment until a time is chosen', async () => {
            const blockedResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });
            expect(blockedResult.transitionOrderToState.transitionError).toBe(PICKUP_TIME_REQUIRED_ERROR);

            const timeResult = await setPickupTime('10:30 AM');
            expect(timeResult.setOrderCustomFields.customFields.pickupTime).toBe('10:30 AM');

            const actualResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });
            expect(actualResult.transitionOrderToState.state).toBe('ArrangingPayment');
        });

        it('drops the time when the customer switches to delivery', async () => {
            await shopClient.query(TRANSITION, { state: 'AddingItems' });

            const actualResult = await shopClient.query(SET_SHIPPING_METHOD, { ids: [deliveryMethodId] });

            expect(actualResult.setOrderShippingMethod.customFields.pickupTime).toBeNull();
        });

        it('copies the hours and the chosen time onto a placed Take Away order', async () => {
            await shopClient.query(SET_SHIPPING_METHOD, { ids: [pickupMethodId] });
            await setPickupTime('11:00 AM');

            const actualSnapshot = await placeOrder();

            expect(actualSnapshot.isTakeAway).toBe(true);
            expect(actualSnapshot.pickupAddress).toBe('1 Market Street');
            expect(actualSnapshot.pickupSlot).toEqual(HOURS);
            expect(actualSnapshot.pickupTime).toBe('11:00 AM');
        });

        it('leaves a delivery order without hours or time', async () => {
            await startOrder();
            await shopClient.query(SET_SHIPPING_METHOD, { ids: [deliveryMethodId] });

            const actualSnapshot = await placeOrder();

            expect(actualSnapshot.isTakeAway).toBe(false);
            expect(actualSnapshot.pickupSlot).toEqual({ from: null, to: null });
            expect(actualSnapshot.pickupTime).toBeNull();
        });

        it('asks for no time on a pickup method without hours', async () => {
            await startOrder();
            const setResult = await shopClient.query(SET_SHIPPING_METHOD, { ids: [pickupWithoutHoursMethodId] });
            expect(setResult.setOrderShippingMethod.message).toBeUndefined();

            const actualResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });

            expect(actualResult.transitionOrderToState.state).toBe('ArrangingPayment');
        });
    });
});
