import { CustomFieldConfig, mergeConfig } from '@vendure/core';
import {
    createTestEnvironment,
    registerInitializer,
    SqljsInitializer,
    testConfig,
} from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { customFields } from '../../../../vendure-config-custom-fields';
import { initialData } from '../../scheduled-availability/e2e/fixtures/initial-data';
import { CartValidationPlugin } from '../cart-validation.plugin';

/**
 * End-to-end coverage for the channel minimum order value: a real Vendure
 * server, the real order process and the real `validationStatus` resolver,
 * driven through the Admin API (to set the minimum) and the Shop API (the way
 * the app and the website drive checkout).
 *
 * What this buys over `minimum-order.spec.ts`. The unit tests prove the maths
 * and the message; nothing there proves that the Channel custom field is read
 * from `ctx.channel` after an admin edit, that the schema extension resolves,
 * or that the OrderProcess is actually registered and refuses the move to
 * ArrangingPayment with the message as the transition error.
 *
 * The fixture's only tax rate is 0%, so subTotalWithTax is exactly
 * price x quantity and the amounts below are exact.
 */

// See scheduled-availability.e2e-spec.ts for why this is not `import.meta.url`.
const dataDir = path.join(process.cwd(), 'src/plugins/Essentials/cart-validation/e2e/__data__');

registerInitializer('sqljs', new SqljsInitializer(dataDir));

// The real definition from the main config, not a copy, so the test breaks if
// the field's name or type changes there.
const minimumOrderAmountField = customFields!.Channel!.find(
    (field: CustomFieldConfig) => field.name === 'minimumOrderAmount',
);
if (!minimumOrderAmountField) {
    throw new Error('Channel.minimumOrderAmount is missing from vendure-config-custom-fields.ts');
}

const { server, adminClient, shopClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [CartValidationPlugin],
        customFields: { Channel: [minimumOrderAmountField] },
        apiOptions: { port: 3061 },
    }),
);

const MINIMUM = 29900;
const CARROT_PRICE = 5000;
const ONION_PRICE = 4900;
const BELOW_MINIMUM_MESSAGE = 'Add products worth ₹49 more to checkout. Minimum order value is ₹299.';

const NO_MINIMUM_STATUS = {
    meetsMinimumOrder: true,
    minimumOrderAmount: null,
    amountToMinimumOrder: 0,
    minimumOrderMessage: null,
};

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

const ACTIVE_CHANNEL = gql`
    query ActiveChannel {
        activeChannel {
            id
            customFields {
                minimumOrderAmount
            }
        }
    }
`;

const UPDATE_CHANNEL = gql`
    mutation UpdateChannel($input: UpdateChannelInput!) {
        updateChannel(input: $input) {
            ... on Channel {
                id
                customFields {
                    minimumOrderAmount
                }
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

// `lines { productVariant { id } }` is selected on purpose:
// CartValidationService.validateOrder reads `order.lines` and
// `line.productVariant.id` unguarded, and Vendure only loads those relations
// when the query asks for them, so `validationStatus` without them throws
// (pre-existing, not part of the minimum-order change). The app and website
// always select lines with their variant alongside validationStatus.
const ORDER_FIELDS = `
    id
    state
    subTotalWithTax
    lines {
        id
        productVariant {
            id
        }
    }
    validationStatus {
        isValid
        hasUnavailableItems
        totalUnavailableItems
        message
        meetsMinimumOrder
        minimumOrderAmount
        amountToMinimumOrder
        minimumOrderMessage
    }
`;

const ADD_ITEM = gql`
    mutation AddItem($productVariantId: ID!, $quantity: Int!) {
        addItemToOrder(productVariantId: $productVariantId, quantity: $quantity) {
            ... on Order {
                ${ORDER_FIELDS}
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;

const ACTIVE_ORDER = gql`
    query ActiveOrder {
        activeOrder {
            ${ORDER_FIELDS}
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
                fromState
                toState
            }
        }
    }
`;

describe('Channel minimum order value (e2e)', () => {
    let channelId: string;
    let carrotVariantId: string;
    let onionVariantId: string;
    let shippingMethodId: string;

    const setChannelMinimum = async (minimumOrderAmount: number | null) => {
        const result = await adminClient.query(UPDATE_CHANNEL, {
            input: { id: channelId, customFields: { minimumOrderAmount } },
        });
        expect(result.updateChannel.message).toBeUndefined();
        return result.updateChannel;
    };

    /**
     * A fresh guest session with a cart of [quantity] carrots, a customer, a
     * shipping address and a shipping method: everything checkout needs, so
     * the minimum is the only thing that can block it.
     */
    const startCheckoutReadyCart = async (quantity: number) => {
        await shopClient.asAnonymousUser();
        const addResult = await shopClient.query(ADD_ITEM, { productVariantId: carrotVariantId, quantity });
        expect(addResult.addItemToOrder.message).toBeUndefined();

        const customerResult = await shopClient.query(SET_CUSTOMER, {
            input: { emailAddress: `min-${quantity}-${Date.now()}@example.com`, firstName: 'Min', lastName: 'Order' },
        });
        expect(customerResult.setCustomerForOrder.message).toBeUndefined();

        const addressResult = await shopClient.query(SET_SHIPPING_ADDRESS, {
            input: { streetLine1: '1 Market Street', city: 'Madurai', postalCode: '625001', countryCode: 'IN' },
        });
        expect(addressResult.setOrderShippingAddress.message).toBeUndefined();

        const methodResult = await shopClient.query(SET_SHIPPING_METHOD, { ids: [shippingMethodId] });
        expect(methodResult.setOrderShippingMethod.message).toBeUndefined();

        return addResult.addItemToOrder;
    };

    /** One product with a single untracked variant; returns the variant id. */
    const createVariant = async (name: string, sku: string, price: number): Promise<string> => {
        const productResult = await adminClient.query(CREATE_PRODUCT, {
            input: { translations: [{ languageCode: 'en', name, slug: sku.toLowerCase(), description: name }] },
        });
        const variantResult = await adminClient.query(CREATE_VARIANTS, {
            input: [
                {
                    productId: productResult.createProduct.id,
                    sku,
                    price,
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

        const channelResult = await adminClient.query(ACTIVE_CHANNEL);
        channelId = channelResult.activeChannel.id;

        carrotVariantId = await createVariant('Carrot 1kg', 'CARROT', CARROT_PRICE);
        onionVariantId = await createVariant('Onion 1kg', 'ONION', ONION_PRICE);

        const shippingResult = await adminClient.query(CREATE_SHIPPING_METHOD, {
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
                        { name: 'rate', value: '3000' },
                        { name: 'includesTax', value: 'auto' },
                        { name: 'taxRate', value: '0' },
                    ],
                },
            },
        });
        shippingMethodId = shippingResult.createShippingMethod.id;
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    describe('channel without a minimum', () => {
        it('starts with the field default of 0', async () => {
            const actualResult = await adminClient.query(ACTIVE_CHANNEL);

            expect(actualResult.activeChannel.customFields.minimumOrderAmount).toBe(0);
        });

        it('reports no minimum and lets a 0 minimum check out', async () => {
            const order = await startCheckoutReadyCart(1);
            expect(order.subTotalWithTax).toBe(CARROT_PRICE);
            expect(order.validationStatus).toMatchObject(NO_MINIMUM_STATUS);

            const actualResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });

            expect(actualResult.transitionOrderToState.state).toBe('ArrangingPayment');
        });

        it('treats a null minimum as no minimum', async () => {
            const channel = await setChannelMinimum(null);
            expect(channel.customFields.minimumOrderAmount).toBeNull();

            const order = await startCheckoutReadyCart(1);
            expect(order.validationStatus).toMatchObject(NO_MINIMUM_STATUS);

            const actualResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });

            expect(actualResult.transitionOrderToState.state).toBe('ArrangingPayment');
        });
    });

    describe('channel with a ₹299 minimum', () => {
        beforeAll(async () => {
            const channel = await setChannelMinimum(MINIMUM);
            expect(channel.customFields.minimumOrderAmount).toBe(MINIMUM);
        });

        it('reports how much more a ₹250 cart needs', async () => {
            // 5 x 5000 at 0% tax.
            const order = await startCheckoutReadyCart(5);
            expect(order.subTotalWithTax).toBe(25000);

            expect(order.validationStatus).toMatchObject({
                meetsMinimumOrder: false,
                minimumOrderAmount: MINIMUM,
                amountToMinimumOrder: MINIMUM - order.subTotalWithTax,
                minimumOrderMessage: BELOW_MINIMUM_MESSAGE,
            });
            expect(order.validationStatus.amountToMinimumOrder).toBe(4900);
        });

        it('leaves availability untouched for an available cart below the minimum', async () => {
            const actualResult = await shopClient.query(ACTIVE_ORDER);

            expect(actualResult.activeOrder.validationStatus).toMatchObject({
                isValid: true,
                hasUnavailableItems: false,
                totalUnavailableItems: 0,
                message: null,
            });
        });

        it('refuses checkout with the message and keeps the order in AddingItems', async () => {
            const actualResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });

            expect(actualResult.transitionOrderToState).toMatchObject({
                errorCode: 'ORDER_STATE_TRANSITION_ERROR',
                transitionError: BELOW_MINIMUM_MESSAGE,
                fromState: 'AddingItems',
                toState: 'ArrangingPayment',
            });
            const orderResult = await shopClient.query(ACTIVE_ORDER);
            expect(orderResult.activeOrder.state).toBe('AddingItems');
        });

        it('meets the minimum exactly at ₹299 and checks out', async () => {
            const addResult = await shopClient.query(ADD_ITEM, { productVariantId: onionVariantId, quantity: 1 });
            const order = addResult.addItemToOrder;
            expect(order.subTotalWithTax).toBe(MINIMUM);

            expect(order.validationStatus).toMatchObject({
                isValid: true,
                hasUnavailableItems: false,
                meetsMinimumOrder: true,
                minimumOrderAmount: MINIMUM,
                amountToMinimumOrder: 0,
                minimumOrderMessage: null,
            });

            const actualResult = await shopClient.query(TRANSITION, { state: 'ArrangingPayment' });

            expect(actualResult.transitionOrderToState.state).toBe('ArrangingPayment');
        });
    });
});
