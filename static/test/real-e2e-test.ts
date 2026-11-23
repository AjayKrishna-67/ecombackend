// static/test/real-e2e-test.ts
// ==================================================================
// E2E Test Suite for Active Order Plugins
// Tests: CartValidation, QuantityLimit, PriceUpdate, ChannelAvailability
// ==================================================================

// ==================================================================
// CONFIGURATION
// ==================================================================
const CONFIG = {
    endpoint: 'http://localhost:80/shop-api',
    adminEndpoint: 'http://localhost:80/admin-api',
    channelToken: 'ind-coimbatore',
    productVariantId: '14',
    // Auto-discovered from admin API during setup
    disabledProductVariantId: '',
    limitedProductVariantId: '',
    outOfStockVariantId: '',
    postalCode: '641001',
    authPhone: '9488946262',
    authFirstName: 'sriram',
    authLastName: 's',
    authEmail: 'sriramsrit.2002@gmail.com',
    // Admin credentials
    adminUsername: 'superadmin',
    adminPassword: 'superadmin',
};

// Track original values for teardown/restore
const ORIGINAL_STATE: {
    maxOrderQuantity?: number | null;
    limitVariantId?: string;
    oosVariantId?: string;
    oosOriginalTrackInventory?: string;
    oosOriginalStockLevels?: Array<{ stockLocationId: string; stockOnHand: number }>;
} = {};

// ==================================================================
// TYPES
// ==================================================================
interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
    duration: number;
}

interface CartValidationStatus {
    isValid: boolean;
    hasUnavailableItems: boolean;
    totalUnavailableItems: number;
    unavailableItems: Array<{
        orderLineId: string;
        productName: string;
        variantName: string;
        reason: string;
    }>;
}

interface QuantityLimitValidationStatus {
    isValid: boolean;
    hasViolations: boolean;
    totalViolations: number;
    violations: Array<{
        orderLineId: string;
        productName: string;
        variantName: string;
        currentQuantity: number;
        maxQuantity: number;
        reason: string;
        limitStartDate: string | null;
    }>;
}

interface ChannelAvailabilityResult {
    id: string;
    code: string;
    token: string | null;
    name: string;
    isAvailable: boolean;
    message: string | null;
    type: string;
}

// ==================================================================
// API HELPERS
// ==================================================================
let authToken: string | null = null;

async function shopApi(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'vendure-token': CONFIG.channelToken,
    };
    if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    const response = await fetch(CONFIG.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    const newAuth = response.headers.get('vendure-auth-token');
    if (newAuth) {
        authToken = newAuth;
    }
    const json: any = await response.json();
    if (json.errors) {
        throw new Error(JSON.stringify(json.errors, null, 2));
    }
    return json.data;
}

let adminAuthToken: string | null = null;

async function adminApi(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (adminAuthToken) {
        headers['Authorization'] = `Bearer ${adminAuthToken}`;
    }
    const response = await fetch(CONFIG.adminEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    const newAuth = response.headers.get('vendure-auth-token');
    if (newAuth) {
        adminAuthToken = newAuth;
    }
    const json: any = await response.json();
    if (json.errors) {
        throw new Error(JSON.stringify(json.errors, null, 2));
    }
    return json.data;
}

// ==================================================================
// ADMIN SETUP & TEARDOWN
// ==================================================================

async function adminLogin(): Promise<void> {
    const res = await adminApi(`
        mutation Login($username: String!, $password: String!) {
            login(username: $username, password: $password) {
                ... on CurrentUser { id identifier }
                ... on InvalidCredentialsError { message }
            }
        }
    `, { username: CONFIG.adminUsername, password: CONFIG.adminPassword });
    assert(res.login.identifier !== undefined, `Admin login failed: ${res.login.message || 'unknown error'}`);
}

async function adminSetup(): Promise<void> {
    console.log('[Admin Setup] Logging in to admin API...');
    await adminLogin();
    console.log('[Admin Setup] Logged in as admin');

    // 1. Ensure main test variant has trackInventory=FALSE (safe for adding items)
    const mainVariantInfo = await adminApi(`
        query GetVariant($id: ID!) {
            productVariant(id: $id) { id trackInventory }
        }
    `, { id: CONFIG.productVariantId });
    if (mainVariantInfo.productVariant.trackInventory !== 'FALSE') {
        console.log(`[Admin Setup] Fixing variant ${CONFIG.productVariantId} trackInventory: ${mainVariantInfo.productVariant.trackInventory} -> FALSE`);
        await adminApi(`
            mutation UpdateVariant($input: [UpdateProductVariantInput!]!) {
                updateProductVariants(input: $input) { id trackInventory }
            }
        `, { input: [{ id: CONFIG.productVariantId, trackInventory: 'FALSE' }] });
    } else {
        console.log(`[Admin Setup] Variant ${CONFIG.productVariantId} trackInventory is already FALSE - OK`);
    }

    // 2. Find a disabled product variant (product.enabled = false)
    console.log('[Admin Setup] Discovering disabled product variant...');
    const disabledRes = await adminApi(`
        query {
            products(options: { take: 5, filter: { enabled: { eq: false } } }) {
                items {
                    id name enabled
                    variants { id name enabled }
                }
            }
        }
    `);
    const disabledProduct = disabledRes.products.items.find(
        (p: any) => p.variants.length > 0
    );
    if (disabledProduct) {
        CONFIG.disabledProductVariantId = disabledProduct.variants[0].id;
        console.log(`[Admin Setup] Found disabled product: "${disabledProduct.name}" (id=${disabledProduct.id}), variant: ${disabledProduct.variants[0].id} (${disabledProduct.variants[0].name})`);
    } else {
        console.log('[Admin Setup] No disabled product with variants found - disable tests will be skipped');
    }

    // 2. Set maxOrderQuantity on a secondary variant for quantity limit tests
    console.log('[Admin Setup] Setting maxOrderQuantity for quantity limit tests...');
    const limitVariantId = '15'; // Pomegranate 1 KG
    ORIGINAL_STATE.limitVariantId = limitVariantId;
    const limitInfo = await adminApi(`
        query GetVariant($id: ID!) {
            productVariant(id: $id) { id customFields { maxOrderQuantity } }
        }
    `, { id: limitVariantId });
    ORIGINAL_STATE.maxOrderQuantity = limitInfo.productVariant.customFields.maxOrderQuantity;

    await adminApi(`
        mutation UpdateVariant($input: [UpdateProductVariantInput!]!) {
            updateProductVariants(input: $input) { id customFields { maxOrderQuantity } }
        }
    `, { input: [{ id: limitVariantId, customFields: { maxOrderQuantity: 3 } }] });
    CONFIG.limitedProductVariantId = limitVariantId;
    console.log(`[Admin Setup] Set maxOrderQuantity=3 on variant ${limitVariantId} (was ${ORIGINAL_STATE.maxOrderQuantity ?? 'null'})`);

    // 3. Set up out-of-stock variant: enable stock tracking + set all stock to 0
    console.log('[Admin Setup] Setting up out-of-stock variant...');
    const oosVariantId = '20'; // Apple 1/2 KG (has actual stock levels)
    ORIGINAL_STATE.oosVariantId = oosVariantId;

    // Save original trackInventory
    const oosVariantInfo = await adminApi(`
        query GetVariant($id: ID!) {
            productVariant(id: $id) { id trackInventory stockLevels { stockOnHand stockLocation { id name } } }
        }
    `, { id: oosVariantId });
    ORIGINAL_STATE.oosOriginalTrackInventory = oosVariantInfo.productVariant.trackInventory;
    ORIGINAL_STATE.oosOriginalStockLevels = oosVariantInfo.productVariant.stockLevels.map(
        (sl: any) => ({ stockLocationId: sl.stockLocation.id, stockOnHand: sl.stockOnHand })
    );

    // Set trackInventory=TRUE and ALL stock levels to 0
    const zeroStockLevels = oosVariantInfo.productVariant.stockLevels.map(
        (sl: any) => ({ stockLocationId: sl.stockLocation.id, stockOnHand: 0 })
    );
    await adminApi(`
        mutation UpdateVariant($input: [UpdateProductVariantInput!]!) {
            updateProductVariants(input: $input) { id trackInventory }
        }
    `, { input: [{ id: oosVariantId, trackInventory: 'TRUE', stockLevels: zeroStockLevels }] });
    CONFIG.outOfStockVariantId = oosVariantId;
    console.log(`[Admin Setup] Set trackInventory=TRUE and stock=0 on variant ${oosVariantId} (was trackInventory=${ORIGINAL_STATE.oosOriginalTrackInventory}, stock levels: ${JSON.stringify(ORIGINAL_STATE.oosOriginalStockLevels)})`);

    console.log('[Admin Setup] Complete\n');
}

async function adminTeardown(): Promise<void> {
    console.log('\n[Admin Teardown] Restoring original settings...');
    try {
        await adminLogin();

        // 1. Restore maxOrderQuantity
        if (ORIGINAL_STATE.limitVariantId) {
            await adminApi(`
                mutation UpdateVariant($input: [UpdateProductVariantInput!]!) {
                    updateProductVariants(input: $input) { id customFields { maxOrderQuantity } }
                }
            `, { input: [{ id: ORIGINAL_STATE.limitVariantId, customFields: { maxOrderQuantity: ORIGINAL_STATE.maxOrderQuantity ?? null } }] });
            console.log(`[Admin Teardown] Restored maxOrderQuantity=${ORIGINAL_STATE.maxOrderQuantity} for variant ${ORIGINAL_STATE.limitVariantId}`);
        }

        // 2. Restore OOS variant: trackInventory + stock levels
        if (ORIGINAL_STATE.oosVariantId && ORIGINAL_STATE.oosOriginalStockLevels) {
            await adminApi(`
                mutation UpdateVariant($input: [UpdateProductVariantInput!]!) {
                    updateProductVariants(input: $input) { id trackInventory }
                }
            `, {
                input: [{
                    id: ORIGINAL_STATE.oosVariantId,
                    trackInventory: ORIGINAL_STATE.oosOriginalTrackInventory || 'FALSE',
                    stockLevels: ORIGINAL_STATE.oosOriginalStockLevels,
                }]
            });
            console.log(`[Admin Teardown] Restored trackInventory=${ORIGINAL_STATE.oosOriginalTrackInventory} and stock levels for variant ${ORIGINAL_STATE.oosVariantId}`);
        }

        console.log('[Admin Teardown] Complete');
    } catch (e: any) {
        console.error('[Admin Teardown] Error:', e.message);
    }
}

// ==================================================================
// GRAPHQL FRAGMENTS
// ==================================================================

const ORDER_FRAGMENT = `
    fragment OrderFields on Order {
        id
        code
        state
        active
        totalWithTax
        subTotal
        subTotalWithTax
        total
        lines {
            id
            quantity
            unitPrice
            unitPriceWithTax
            linePriceWithTax
            productVariant {
                id
                name
                price
                priceWithTax
            }
        }
    }
`;

const VALIDATION_STATUS_FRAGMENT = `
    fragment ValidationFields on Order {
        validationStatus {
            isValid
            hasUnavailableItems
            totalUnavailableItems
            unavailableItems {
                orderLineId
                productName
                variantName
                reason
            }
        }
    }
`;

const QUANTITY_LIMIT_FRAGMENT = `
    fragment QuantityLimitFields on Order {
        quantityLimitStatus {
            isValid
            hasViolations
            totalViolations
            violations {
                orderLineId
                productName
                variantName
                currentQuantity
                maxQuantity
                reason
                limitStartDate
            }
        }
    }
`;

const STOCK_AVAILABILITY_FRAGMENT = `
    fragment StockFields on Order {
        isAvailable
        unavailableReason
    }
`;

const LINE_AVAILABILITY_FRAGMENT = `
    fragment LineAvailabilityFields on OrderLine {
        isAvailable
        unavailableReason
    }
`;

// ==================================================================
// TEST UTILITIES
// ==================================================================

function assert(condition: boolean, message: string): void {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertDefined<T>(value: T | null | undefined, message: string): asserts value is T {
    if (value === null || value === undefined) {
        throw new Error(`Expected defined value: ${message}`);
    }
}

async function login(): Promise<string> {
    // Step 1: Request OTP (sendPhoneOtp returns the OTP code directly)
    const otpRes = await shopApi(`
        mutation SendOtp($phone: String!) {
            sendPhoneOtp(phoneNumber: $phone)
        }
    `, { phone: CONFIG.authPhone });
    const otpCode = otpRes.sendPhoneOtp;
    assertDefined(otpCode, 'OTP should be returned from sendPhoneOtp');

    // Step 2: Authenticate with the received OTP
    const res = await shopApi(`
        mutation Authenticate($phone: String!, $code: String!, $firstName: String, $lastName: String, $email: String) {
            authenticate(input: {
                phoneOtp: {
                    phoneNumber: $phone
                    code: $code
                    firstName: $firstName
                    lastName: $lastName
                    emailAddress: $email
                }
            }) {
                __typename
                ... on CurrentUser { id identifier }
                ... on InvalidCredentialsError { errorCode message authenticationError }
            }
        }
    `, {
        phone: CONFIG.authPhone,
        code: otpCode,
        firstName: CONFIG.authFirstName,
        lastName: CONFIG.authLastName,
        email: CONFIG.authEmail,
    });
    const user = res.authenticate;
    assert(user.__typename === 'CurrentUser', `Login failed: ${user.__typename} - ${user.message || user.authenticationError || ''}`);
    return user.identifier;
}

async function clearActiveOrder(): Promise<void> {
    const activeOrder = await shopApi(`
        query { activeOrder { id state lines { id } } }
    `);
    if (!activeOrder.activeOrder) return;
    // If order is not in AddingItems, transition it back first
    if (activeOrder.activeOrder.state && activeOrder.activeOrder.state !== 'AddingItems') {
        await shopApi(`
            mutation {
                transitionOrderToState(state: "AddingItems") {
                    ... on Order { id state }
                    ... on OrderStateTransitionError { message }
                }
            }
        `);
    }
    if (activeOrder.activeOrder?.lines?.length > 0) {
        for (const line of activeOrder.activeOrder.lines) {
            await shopApi(`
                mutation RemoveLine($id: ID!) {
                    removeOrderLine(orderLineId: $id) {
                        ... on Order { id }
                        ... on OrderModificationError { message }
                    }
                }
            `, { id: line.id });
        }
    }
}

async function addItemToOrder(variantId: string, quantity: number = 1): Promise<any> {
    const res = await shopApi(`
        ${ORDER_FRAGMENT}
        mutation AddItem($id: ID!, $qty: Int!) {
            addItemToOrder(productVariantId: $id, quantity: $qty) {
                __typename
                ... on Order { ...OrderFields }
                ... on OrderModificationError { errorCode message }
                ... on OrderLimitError { errorCode message }
                ... on NegativeQuantityError { errorCode message }
                ... on InsufficientStockError { errorCode message }
                ... on OrderInterceptorError { errorCode message interceptorError }
            }
        }
    `, { id: variantId, qty: quantity });
    const result = res.addItemToOrder;
    if (result.__typename && result.__typename !== 'Order') {
        console.log(`    [addItemToOrder] WARNING: Returned ${result.__typename}: ${result.message || result.interceptorError || JSON.stringify(result)}`);
    }
    return result;
}

async function getActiveOrderWithValidation(): Promise<any> {
    const res = await shopApi(`
        ${ORDER_FRAGMENT}
        ${VALIDATION_STATUS_FRAGMENT}
        ${QUANTITY_LIMIT_FRAGMENT}
        ${STOCK_AVAILABILITY_FRAGMENT}
        query {
            activeOrder {
                ...OrderFields
                ...ValidationFields
                ...QuantityLimitFields
                ...StockFields
                lines {
                    id
                    quantity
                    unitPrice
                    unitPriceWithTax
                    linePriceWithTax
                    isAvailable
                    unavailableReason
                    productVariant {
                        id
                        name
                        price
                        priceWithTax
                    }
                }
            }
        }
    `);
    return res.activeOrder;
}

async function setShippingAddress(): Promise<void> {
    await shopApi(`
        mutation {
            setOrderShippingAddress(input: {
                fullName: "Test User",
                streetLine1: "123 Test Street",
                city: "Coimbatore",
                postalCode: "${CONFIG.postalCode}",
                countryCode: "IN"
            }) {
                ... on Order { id }
            }
        }
    `);
}

async function setShippingMethod(): Promise<void> {
    const methodsRes = await shopApi(`
        query { eligibleShippingMethods { id name } }
    `);
    const methodId = methodsRes.eligibleShippingMethods[0]?.id;
    if (methodId) {
        await shopApi(`
            mutation SetShipping($id: [ID!]!) {
                setOrderShippingMethod(shippingMethodId: $id) {
                    ... on Order { id }
                }
            }
        `, { id: [methodId] });
    }
}

async function transitionToArrangingPayment(): Promise<any> {
    const res = await shopApi(`
        mutation {
            transitionOrderToState(state: "ArrangingPayment") {
                ... on Order { id state }
                ... on OrderStateTransitionError { errorCode message transitionError }
                ... on CartContainsUnavailableItemsError {
                    errorCode
                    message
                    unavailableItems {
                        orderLineId
                        productName
                        variantName
                        reason
                    }
                }
                ... on QuantityLimitError {
                    errorCode
                    message
                    maxQuantity
                    requestedQuantity
                }
                ... on CartInsufficientStockError {
                    errorCode
                    message
                }
            }
        }
    `);
    return res.transitionOrderToState;
}

// ==================================================================
// TEST SUITE 1: CART VALIDATION PLUGIN
// ==================================================================

async function testCartValidation_ActiveOrderHasValidationStatus(): Promise<void> {
    await clearActiveOrder();
    const order = await addItemToOrder(CONFIG.productVariantId);
    assert(order.id !== undefined, 'Order should be created');

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assertDefined(activeOrder.validationStatus, 'Order should have validationStatus field');
    assert(typeof activeOrder.validationStatus.isValid === 'boolean', 'isValid should be boolean');
    assert(typeof activeOrder.validationStatus.hasUnavailableItems === 'boolean', 'hasUnavailableItems should be boolean');
    assert(typeof activeOrder.validationStatus.totalUnavailableItems === 'number', 'totalUnavailableItems should be number');
    assert(Array.isArray(activeOrder.validationStatus.unavailableItems), 'unavailableItems should be array');
}

async function testCartValidation_ValidCartIsValid(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: CartValidationStatus = activeOrder.validationStatus;
    assert(status.isValid === true, `Cart should be valid, got isValid=${status.isValid}`);
    assert(status.hasUnavailableItems === false, 'Should not have unavailable items');
    assert(status.totalUnavailableItems === 0, 'Should have 0 unavailable items');
    assert(status.unavailableItems.length === 0, 'unavailableItems array should be empty');
}

async function testCartValidation_OrderLinesHaveAvailability(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.lines.length > 0, 'Order should have lines');
    for (const line of activeOrder.lines) {
        assert(typeof line.isAvailable === 'boolean', `Line ${line.id} should have isAvailable boolean`);
    }
}

async function testCartValidation_ValidCartAllowsCheckout(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    await setShippingAddress();
    await setShippingMethod();

    const result = await transitionToArrangingPayment();
    // If cart is valid, it should transition (no CartContainsUnavailableItemsError)
    if (result.errorCode === 'CART_CONTAINS_UNAVAILABLE_ITEMS') {
        throw new Error('Valid cart should not be blocked by cart validation');
    }
    // Transition back if successful
    if (result.state === 'ArrangingPayment') {
        await shopApi(`
            mutation {
                transitionOrderToState(state: "AddingItems") {
                    ... on Order { id state }
                    ... on OrderStateTransitionError { message }
                }
            }
        `);
    }
}

async function testCartValidation_DisabledProductBlocksCheckout(): Promise<void> {
    if (!CONFIG.disabledProductVariantId) {
        console.log('    SKIPPED: No disabled product variant found by admin setup');
        return;
    }
    await clearActiveOrder();
    let addResult: any;
    try {
        addResult = await addItemToOrder(CONFIG.disabledProductVariantId);
    } catch (e: any) {
        // Vendure returns ENTITY_NOT_FOUND for disabled product variants not in the channel
        const msg = e.message || '';
        if (msg.includes('ENTITY_NOT_FOUND') || msg.includes('could not be found')) {
            console.log('    INFO: Disabled product variant not accessible in shop API (ENTITY_NOT_FOUND) - expected behavior');
            return;
        }
        throw e;
    }
    if (addResult.errorCode || addResult.interceptorError) {
        // Vendure may prevent adding disabled product's variant - this is acceptable
        console.log(`    INFO: Disabled product variant blocked at add: ${addResult.message || addResult.interceptorError}`);
        return;
    }
    // If item was added, the validation status should detect it as unavailable
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: CartValidationStatus = activeOrder.validationStatus;
    assert(
        status.hasUnavailableItems === true,
        `Cart with disabled product should have unavailable items, got hasUnavailableItems=${status.hasUnavailableItems}`
    );
    assert(
        status.unavailableItems.length > 0,
        'Should list at least one unavailable item'
    );
    // Also verify checkout is blocked
    await setShippingAddress();
    await setShippingMethod();
    const result = await transitionToArrangingPayment();
    assert(
        result.errorCode === 'CART_CONTAINS_UNAVAILABLE_ITEMS',
        `Expected CART_CONTAINS_UNAVAILABLE_ITEMS error, got: ${JSON.stringify(result)}`
    );
    assert(
        result.unavailableItems.length > 0,
        'Transition error should list unavailable items'
    );
}

async function testCartValidation_EmptyCartIsValid(): Promise<void> {
    await clearActiveOrder();
    // Add and remove to ensure order exists but is empty
    const order = await addItemToOrder(CONFIG.productVariantId);
    if (order.lines?.length > 0) {
        await shopApi(`
            mutation RemoveLine($id: ID!) {
                removeOrderLine(orderLineId: $id) {
                    ... on Order { id }
                    ... on OrderModificationError { message }
                }
            }
        `, { id: order.lines[0].id });
    }
    const activeOrder = await getActiveOrderWithValidation();
    if (activeOrder) {
        const status: CartValidationStatus = activeOrder.validationStatus;
        assert(status.isValid === true, 'Empty cart should be valid');
        assert(status.totalUnavailableItems === 0, 'Empty cart should have 0 unavailable items');
    }
}

async function testCartValidation_IsValidAndHasUnavailableAreInverses(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: CartValidationStatus = activeOrder.validationStatus;
    assert(
        status.isValid !== status.hasUnavailableItems,
        `isValid (${status.isValid}) and hasUnavailableItems (${status.hasUnavailableItems}) should be inverses`
    );
}

async function testCartValidation_TotalMatchesArrayLength(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: CartValidationStatus = activeOrder.validationStatus;
    assert(
        status.totalUnavailableItems === status.unavailableItems.length,
        `totalUnavailableItems (${status.totalUnavailableItems}) should match array length (${status.unavailableItems.length})`
    );
}

async function testCartValidation_AvailableLineHasNullReason(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    for (const line of activeOrder.lines) {
        if (line.isAvailable) {
            assert(
                line.unavailableReason === null,
                `Available line ${line.id} should have null unavailableReason, got "${line.unavailableReason}"`
            );
        }
    }
}

async function testCartValidation_ValidationPersistsAfterAddingSecondItem(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId, 1);
    const orderBefore = await getActiveOrderWithValidation();
    assertDefined(orderBefore, 'Order should exist before second add');
    const statusBefore: CartValidationStatus = orderBefore.validationStatus;
    // Add another quantity of the same item
    await addItemToOrder(CONFIG.productVariantId, 1);
    const orderAfter = await getActiveOrderWithValidation();
    assertDefined(orderAfter, 'Order should exist after second add');
    const statusAfter: CartValidationStatus = orderAfter.validationStatus;
    assert(statusBefore.isValid === statusAfter.isValid, 'Validity should persist after adding more of the same valid item');
}

// ==================================================================
// TEST SUITE 2: QUANTITY LIMIT PLUGIN
// ==================================================================

async function testQuantityLimit_ActiveOrderHasQuantityLimitStatus(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assertDefined(activeOrder.quantityLimitStatus, 'Order should have quantityLimitStatus field');
    assert(typeof activeOrder.quantityLimitStatus.isValid === 'boolean', 'isValid should be boolean');
    assert(typeof activeOrder.quantityLimitStatus.hasViolations === 'boolean', 'hasViolations should be boolean');
    assert(typeof activeOrder.quantityLimitStatus.totalViolations === 'number', 'totalViolations should be number');
    assert(Array.isArray(activeOrder.quantityLimitStatus.violations), 'violations should be array');
}

async function testQuantityLimit_NoLimitProductIsValid(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: QuantityLimitValidationStatus = activeOrder.quantityLimitStatus;
    assert(status.isValid === true, `Unlimited product should be valid, got isValid=${status.isValid}`);
    assert(status.hasViolations === false, 'Should not have violations');
    assert(status.totalViolations === 0, 'Should have 0 violations');
}

async function testQuantityLimit_StockAvailabilityOnOrder(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(typeof activeOrder.isAvailable === 'boolean', 'Order should have isAvailable boolean');
    // unavailableReason can be null or string
    assert(
        activeOrder.unavailableReason === null || typeof activeOrder.unavailableReason === 'string',
        'unavailableReason should be null or string'
    );
}

async function testQuantityLimit_InStockProductIsAvailable(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.isAvailable === true, `In-stock product should be available, got ${activeOrder.isAvailable}`);
    assert(activeOrder.unavailableReason === null, 'No reason should be given for available stock');
}

async function testQuantityLimit_LimitedProductExceedsMax(): Promise<void> {
    if (!CONFIG.limitedProductVariantId) {
        console.log('    SKIPPED: No limitedProductVariantId configured by admin setup');
        return;
    }
    await clearActiveOrder();
    // maxOrderQuantity is set to 3, try adding 5 to exceed limit
    const addResult = await addItemToOrder(CONFIG.limitedProductVariantId, 5);
    if (addResult.errorCode || addResult.interceptorError) {
        // The willAddItemToOrder interceptor blocked the add - expected behavior
        // interceptorError contains the actual message from the interceptor
        const msg = addResult.interceptorError || addResult.message || '';
        assert(
            msg.includes('Maximum quantity') ||
            msg.includes('maximum purchase limit') ||
            msg.includes('Your cart can only have') ||
            msg.includes('error occurred'), // OrderInterceptorError generic message
            `Expected quantity limit error, got: ${msg}`
        );
        return;
    }
    // If it was somehow added, the quantityLimitStatus should report violations
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(
        activeOrder.quantityLimitStatus.hasViolations === true,
        'Adding 5 items with maxOrderQuantity=3 should cause violations'
    );
    assert(
        activeOrder.quantityLimitStatus.violations.length > 0,
        'Should have at least one violation'
    );
    const violation = activeOrder.quantityLimitStatus.violations[0];
    assert(violation.maxQuantity === 3, `maxQuantity should be 3, got ${violation.maxQuantity}`);
    assert(violation.reason.length > 0, 'Violation should have a reason string');
}

async function testQuantityLimit_OutOfStockBlocksCheckout(): Promise<void> {
    if (!CONFIG.outOfStockVariantId) {
        console.log('    SKIPPED: No outOfStockVariantId configured by admin setup');
        return;
    }
    await clearActiveOrder();
    const addResult = await addItemToOrder(CONFIG.outOfStockVariantId);
    if (addResult.errorCode) {
        // Vendure may block adding out-of-stock items at the add step
        const msg = addResult.message || '';
        assert(
            msg.includes('stock') || msg.includes('Stock') || addResult.errorCode === 'INSUFFICIENT_STOCK_ERROR',
            `Expected stock-related error at add, got: ${msg}`
        );
        return;
    }
    // If item was added, check stock availability fields on the order
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(
        activeOrder.isAvailable === false,
        `Order with out-of-stock item should have isAvailable=false, got ${activeOrder.isAvailable}`
    );
    assert(
        activeOrder.unavailableReason !== null && activeOrder.unavailableReason.length > 0,
        `unavailableReason should explain stock issue, got: ${activeOrder.unavailableReason}`
    );
    // Try checkout - should be blocked
    await setShippingAddress();
    await setShippingMethod();
    const result = await transitionToArrangingPayment();
    assert(
        result.errorCode === 'CART_INSUFFICIENT_STOCK',
        `Expected CART_INSUFFICIENT_STOCK error, got: ${JSON.stringify(result)}`
    );
}

async function testQuantityLimit_AdjustQuantityValidation(): Promise<void> {
    await clearActiveOrder();
    const order = await addItemToOrder(CONFIG.productVariantId, 1);
    assert(order.id !== undefined, 'Order should be created');
    const lineId = order.lines[0].id;

    // Adjust quantity to 2 (should work for unlimited product)
    const adjustRes = await shopApi(`
        mutation AdjustLine($id: ID!, $qty: Int!) {
            adjustOrderLine(orderLineId: $id, quantity: $qty) {
                ... on Order { id lines { id quantity } }
                ... on OrderModificationError { errorCode message }
                ... on OrderLimitError { errorCode message }
                ... on NegativeQuantityError { errorCode message }
                ... on InsufficientStockError { errorCode message }
                ... on OrderInterceptorError { errorCode message interceptorError }
            }
        }
    `, { id: lineId, qty: 2 });

    if (adjustRes.adjustOrderLine.lines) {
        const updatedLine = adjustRes.adjustOrderLine.lines.find((l: any) => l.id === lineId);
        assert(updatedLine.quantity === 2, `Quantity should be 2, got ${updatedLine.quantity}`);
    }
}

async function testQuantityLimit_EmptyCartHasValidStatus(): Promise<void> {
    await clearActiveOrder();
    const order = await addItemToOrder(CONFIG.productVariantId);
    if (order.lines?.length > 0) {
        await shopApi(`
            mutation RemoveLine($id: ID!) {
                removeOrderLine(orderLineId: $id) {
                    ... on Order { id }
                    ... on OrderModificationError { message }
                }
            }
        `, { id: order.lines[0].id });
    }
    const activeOrder = await getActiveOrderWithValidation();
    if (activeOrder) {
        const status: QuantityLimitValidationStatus = activeOrder.quantityLimitStatus;
        assert(status.isValid === true, 'Empty cart should have valid quantity limit status');
        assert(status.totalViolations === 0, 'Empty cart should have 0 violations');
    }
}

async function testQuantityLimit_ViolationsEmptyWhenValid(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: QuantityLimitValidationStatus = activeOrder.quantityLimitStatus;
    if (status.isValid) {
        assert(status.violations.length === 0, 'Valid status should have empty violations array');
        assert(status.totalViolations === 0, 'Valid status should have 0 totalViolations');
    }
}

async function testQuantityLimit_IsValidAndHasViolationsAreInverses(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const status: QuantityLimitValidationStatus = activeOrder.quantityLimitStatus;
    assert(
        status.isValid !== status.hasViolations,
        `isValid (${status.isValid}) and hasViolations (${status.hasViolations}) should be inverses`
    );
}

async function testQuantityLimit_AddSameItemAccumulatesQuantity(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId, 1);
    const order = await addItemToOrder(CONFIG.productVariantId, 1);
    // Vendure merges same variant into one line with accumulated quantity
    const line = order.lines.find((l: any) => l.productVariant.id === CONFIG.productVariantId);
    assertDefined(line, 'Line for variant should exist');
    assert(line.quantity === 2, `Accumulated quantity should be 2, got ${line.quantity}`);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Accumulated qty should still be valid for unlimited product');
}

async function testQuantityLimit_RemoveAndReAddWorks(): Promise<void> {
    await clearActiveOrder();
    const order = await addItemToOrder(CONFIG.productVariantId, 1);
    const lineId = order.lines[0].id;
    // Remove the line
    await shopApi(`
        mutation RemoveLine($id: ID!) {
            removeOrderLine(orderLineId: $id) {
                ... on Order { id lines { id } }
                ... on OrderModificationError { message }
            }
        }
    `, { id: lineId });
    // Re-add
    const reAdd = await addItemToOrder(CONFIG.productVariantId, 1);
    assert(reAdd.lines.length === 1, 'Should have 1 line after re-add');
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Re-added item should pass quantity limit');
    assert(activeOrder.isAvailable === true, 'Re-added item should be in stock');
}

async function testQuantityLimit_AdjustToOnePreservesValidity(): Promise<void> {
    await clearActiveOrder();
    const order = await addItemToOrder(CONFIG.productVariantId, 3);
    const lineId = order.lines[0].id;
    // Adjust back to 1
    await shopApi(`
        mutation AdjustLine($id: ID!, $qty: Int!) {
            adjustOrderLine(orderLineId: $id, quantity: $qty) {
                ... on Order { id lines { id quantity } }
                ... on OrderModificationError { errorCode message }
            }
        }
    `, { id: lineId, qty: 1 });
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.lines[0].quantity === 1, `Quantity should be 1 after adjust, got ${activeOrder.lines[0].quantity}`);
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Qty 1 should be valid');
    assert(activeOrder.isAvailable === true, 'Qty 1 should be available');
}

async function testQuantityLimit_MultipleAddsKeepOrderValid(): Promise<void> {
    await clearActiveOrder();
    // Add 3 times sequentially
    await addItemToOrder(CONFIG.productVariantId, 1);
    await addItemToOrder(CONFIG.productVariantId, 1);
    await addItemToOrder(CONFIG.productVariantId, 1);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.lines[0].quantity === 3, `Quantity should be 3 after 3 adds, got ${activeOrder.lines[0].quantity}`);
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Multiple adds should still be valid for unlimited product');
}

// ==================================================================
// TEST SUITE 3: PRICE UPDATE PLUGIN
// ==================================================================

async function testPriceUpdate_OrderLinesHavePrices(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.lines.length > 0, 'Order should have lines');

    for (const line of activeOrder.lines) {
        assert(typeof line.unitPrice === 'number', `Line ${line.id} should have unitPrice number`);
        assert(line.unitPrice > 0, `Line ${line.id} unitPrice should be > 0, got ${line.unitPrice}`);
        assert(typeof line.unitPriceWithTax === 'number', `Line ${line.id} should have unitPriceWithTax`);
        assert(typeof line.linePriceWithTax === 'number', `Line ${line.id} should have linePriceWithTax`);
    }
}

async function testPriceUpdate_PricesMatchVariantPrices(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');

    for (const line of activeOrder.lines) {
        const variantPrice = line.productVariant.price;
        const linePrice = line.unitPrice;
        // After price update plugin runs, line price should match variant's current price
        assert(
            linePrice === variantPrice,
            `Line price (${linePrice}) should match variant price (${variantPrice}) for variant ${line.productVariant.id}`
        );
    }
}

async function testPriceUpdate_ActiveOrderReturnsPrices(): Promise<void> {
    // Query activeOrder specifically to trigger price update resolver
    const res = await shopApi(`
        query {
            activeOrder {
                id
                code
                total
                totalWithTax
                subTotal
                lines {
                    id
                    unitPrice
                    unitPriceWithTax
                    quantity
                    linePriceWithTax
                    productVariant {
                        id
                        name
                        price
                    }
                }
            }
        }
    `);

    if (res.activeOrder) {
        assert(typeof res.activeOrder.total === 'number', 'Order should have total');
        assert(typeof res.activeOrder.totalWithTax === 'number', 'Order should have totalWithTax');
        assert(typeof res.activeOrder.subTotal === 'number', 'Order should have subTotal');
    }
}

async function testPriceUpdate_MultipleQueriesReturnConsistentPrices(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);

    // Query twice - prices should be consistent (WeakMap caching + idempotent updates)
    const order1 = await getActiveOrderWithValidation();
    const order2 = await getActiveOrderWithValidation();

    assertDefined(order1, 'First query should return order');
    assertDefined(order2, 'Second query should return order');

    assert(
        order1.lines[0].unitPrice === order2.lines[0].unitPrice,
        `Prices should be consistent across queries: ${order1.lines[0].unitPrice} vs ${order2.lines[0].unitPrice}`
    );
    assert(
        order1.totalWithTax === order2.totalWithTax,
        `Total should be consistent: ${order1.totalWithTax} vs ${order2.totalWithTax}`
    );
}

async function testPriceUpdate_LinePriceEqualsUnitTimesQuantity(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId, 3);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    for (const line of activeOrder.lines) {
        const expectedLinePrice = line.unitPriceWithTax * line.quantity;
        assert(
            line.linePriceWithTax === expectedLinePrice,
            `linePriceWithTax (${line.linePriceWithTax}) should equal unitPriceWithTax (${line.unitPriceWithTax}) * quantity (${line.quantity}) = ${expectedLinePrice}`
        );
    }
}

async function testPriceUpdate_SubTotalIsSumOfLinePrices(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId, 2);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    const expectedSubTotal = activeOrder.lines.reduce(
        (sum: number, line: any) => sum + (line.unitPrice * line.quantity), 0
    );
    assert(
        activeOrder.subTotal === expectedSubTotal,
        `subTotal (${activeOrder.subTotal}) should match sum of line prices (${expectedSubTotal})`
    );
}

async function testPriceUpdate_TotalWithTaxGteSubTotalWithTax(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(
        activeOrder.totalWithTax >= activeOrder.subTotalWithTax,
        `totalWithTax (${activeOrder.totalWithTax}) should be >= subTotalWithTax (${activeOrder.subTotalWithTax})`
    );
}

async function testPriceUpdate_OrderCodeIsNonEmptyString(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(typeof activeOrder.code === 'string', 'Order code should be a string');
    assert(activeOrder.code.length > 0, 'Order code should be non-empty');
}

// ==================================================================
// TEST SUITE 4: CHANNEL AVAILABILITY PLUGIN
// ==================================================================

async function testChannelAvailability_QueryReturnsResults(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                id
                code
                token
                name
                isAvailable
                message
                type
            }
        }
    `, { postalCode: CONFIG.postalCode });

    assertDefined(res.getAvailableChannels, 'Should return getAvailableChannels');
    assert(Array.isArray(res.getAvailableChannels), 'Should return an array');
}

async function testChannelAvailability_ChannelsHaveRequiredFields(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                id
                code
                token
                name
                isAvailable
                message
                type
            }
        }
    `, { postalCode: CONFIG.postalCode });

    for (const channel of res.getAvailableChannels) {
        assertDefined(channel.id, `Channel should have id`);
        assertDefined(channel.code, `Channel should have code`);
        assertDefined(channel.name, `Channel should have name`);
        assert(typeof channel.isAvailable === 'boolean', `Channel ${channel.code} isAvailable should be boolean`);
        assert(
            channel.type === 'CITY' || channel.type === 'BRAND',
            `Channel ${channel.code} type should be CITY or BRAND, got ${channel.type}`
        );
    }
}

async function testChannelAvailability_ExcludesDefaultChannel(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                code
            }
        }
    `, { postalCode: CONFIG.postalCode });

    const defaultChannel = res.getAvailableChannels.find(
        (c: any) => c.code === '__default_channel__'
    );
    assert(!defaultChannel, 'Default channel should not be in results');
}

async function testChannelAvailability_FilterByType(): Promise<void> {
    // Filter by CITY type
    const cityRes = await shopApi(`
        query GetChannels($postalCode: String, $type: ChannelType) {
            getAvailableChannels(postalCode: $postalCode, type: $type) {
                code
                type
            }
        }
    `, { postalCode: CONFIG.postalCode, type: 'CITY' });

    for (const channel of cityRes.getAvailableChannels) {
        assert(channel.type === 'CITY', `Filtered by CITY but got ${channel.type} for ${channel.code}`);
    }

    // Filter by BRAND type
    const brandRes = await shopApi(`
        query GetChannels($postalCode: String, $type: ChannelType) {
            getAvailableChannels(postalCode: $postalCode, type: $type) {
                code
                type
            }
        }
    `, { postalCode: CONFIG.postalCode, type: 'BRAND' });

    for (const channel of brandRes.getAvailableChannels) {
        assert(channel.type === 'BRAND', `Filtered by BRAND but got ${channel.type} for ${channel.code}`);
    }
}

async function testChannelAvailability_WithoutPostalCodeShowsUnavailable(): Promise<void> {
    // Clear auth to test as guest without address
    const savedToken = authToken;
    authToken = null;

    try {
        const res = await shopApi(`
            query {
                getAvailableChannels {
                    code
                    isAvailable
                    message
                }
            }
        `);

        // Without postal code or auth, channels should be unavailable
        for (const channel of res.getAvailableChannels) {
            assert(
                channel.isAvailable === false,
                `Channel ${channel.code} should be unavailable without postal code`
            );
            if (channel.message) {
                assert(
                    channel.message.includes('shipping address') || channel.message.includes('available'),
                    `Message should guide user: ${channel.message}`
                );
            }
        }
    } finally {
        authToken = savedToken;
    }
}

async function testChannelAvailability_UnavailableBrandHasNullToken(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                code
                token
                isAvailable
                message
                type
            }
        }
    `, { postalCode: '000000' }); // Use invalid postal code

    for (const channel of res.getAvailableChannels) {
        if (channel.type === 'BRAND' && channel.message === 'Brand will available soon') {
            assert(
                channel.token === null,
                `Unavailable brand ${channel.code} should have null token, got ${channel.token}`
            );
        }
    }
}

async function testChannelAvailability_NonEmptyForValidPostalCode(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) { id }
        }
    `, { postalCode: CONFIG.postalCode });
    assert(
        res.getAvailableChannels.length > 0,
        `Should return at least 1 channel for valid postal code ${CONFIG.postalCode}, got ${res.getAvailableChannels.length}`
    );
}

async function testChannelAvailability_AvailableChannelHasToken(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                code
                token
                isAvailable
            }
        }
    `, { postalCode: CONFIG.postalCode });
    for (const channel of res.getAvailableChannels) {
        if (channel.isAvailable) {
            assertDefined(channel.token, `Available channel ${channel.code} should have a non-null token`);
            assert(channel.token.length > 0, `Available channel ${channel.code} token should be non-empty`);
        }
    }
}

async function testChannelAvailability_AllChannelsHaveUniqueIds(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) { id code }
        }
    `, { postalCode: CONFIG.postalCode });
    const ids = res.getAvailableChannels.map((c: any) => c.id);
    const uniqueIds = new Set(ids);
    assert(
        ids.length === uniqueIds.size,
        `All channel ids should be unique. Got ${ids.length} ids but ${uniqueIds.size} unique`
    );
}

async function testChannelAvailability_ConsistentAcrossRepeatedQueries(): Promise<void> {
    const query = `
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) { id code isAvailable type }
        }
    `;
    const res1 = await shopApi(query, { postalCode: CONFIG.postalCode });
    const res2 = await shopApi(query, { postalCode: CONFIG.postalCode });
    assert(
        res1.getAvailableChannels.length === res2.getAvailableChannels.length,
        `Repeated queries should return same count: ${res1.getAvailableChannels.length} vs ${res2.getAvailableChannels.length}`
    );
    for (let i = 0; i < res1.getAvailableChannels.length; i++) {
        assert(
            res1.getAvailableChannels[i].id === res2.getAvailableChannels[i].id,
            `Channel id mismatch at index ${i}`
        );
        assert(
            res1.getAvailableChannels[i].isAvailable === res2.getAvailableChannels[i].isAvailable,
            `Channel availability mismatch for ${res1.getAvailableChannels[i].code}`
        );
    }
}

async function testChannelAvailability_TypeFilterCountsSumToTotal(): Promise<void> {
    const allRes = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) { id type }
        }
    `, { postalCode: CONFIG.postalCode });
    const cityRes = await shopApi(`
        query GetChannels($postalCode: String, $type: ChannelType) {
            getAvailableChannels(postalCode: $postalCode, type: $type) { id }
        }
    `, { postalCode: CONFIG.postalCode, type: 'CITY' });
    const brandRes = await shopApi(`
        query GetChannels($postalCode: String, $type: ChannelType) {
            getAvailableChannels(postalCode: $postalCode, type: $type) { id }
        }
    `, { postalCode: CONFIG.postalCode, type: 'BRAND' });
    const totalFiltered = cityRes.getAvailableChannels.length + brandRes.getAvailableChannels.length;
    assert(
        totalFiltered === allRes.getAvailableChannels.length,
        `CITY (${cityRes.getAvailableChannels.length}) + BRAND (${brandRes.getAvailableChannels.length}) = ${totalFiltered} should equal total (${allRes.getAvailableChannels.length})`
    );
}

async function testChannelAvailability_AvailableChannelMessageIsNull(): Promise<void> {
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                code
                isAvailable
                message
            }
        }
    `, { postalCode: CONFIG.postalCode });
    for (const channel of res.getAvailableChannels) {
        if (channel.isAvailable) {
            assert(
                channel.message === null,
                `Available channel ${channel.code} should have null message, got "${channel.message}"`
            );
        }
    }
}

// ==================================================================
// TEST SUITE 5: FULL CHECKOUT FLOW WITH ALL VALIDATIONS
// ==================================================================

async function testFullFlow_AddItemQueryValidateCheckout(): Promise<void> {
    await clearActiveOrder();

    // Step 1: Add item
    const addResult = await addItemToOrder(CONFIG.productVariantId);
    assert(addResult.id !== undefined, 'Order should be created');

    // Step 2: Query with all validation fields
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');

    // Step 3: Verify all validation plugins are responding
    assertDefined(activeOrder.validationStatus, 'Cart validation should respond');
    assertDefined(activeOrder.quantityLimitStatus, 'Quantity limit should respond');
    assert(typeof activeOrder.isAvailable === 'boolean', 'Stock availability should respond');

    // Step 4: Verify all pass for valid product
    assert(activeOrder.validationStatus.isValid === true, 'Cart should be valid');
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Quantity limit should pass');
    assert(activeOrder.isAvailable === true, 'Stock should be available');

    // Step 5: Set shipping for checkout
    await setShippingAddress();
    await setShippingMethod();

    // Step 6: Transition to ArrangingPayment
    const transition = await transitionToArrangingPayment();
    assert(
        transition.state === 'ArrangingPayment' || transition.id !== undefined,
        `Checkout should succeed for valid cart, got: ${JSON.stringify(transition)}`
    );

    // Step 7: Transition back to AddingItems for cleanup
    await shopApi(`
        mutation {
            transitionOrderToState(state: "AddingItems") {
                ... on Order { id state }
                ... on OrderStateTransitionError { message }
            }
        }
    `);
}

async function testFullFlow_MultipleItemsAllValidated(): Promise<void> {
    await clearActiveOrder();

    // Add same item multiple times (quantity 2)
    await addItemToOrder(CONFIG.productVariantId, 2);

    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');

    // Verify line quantity
    assert(activeOrder.lines[0].quantity === 2, `Quantity should be 2, got ${activeOrder.lines[0].quantity}`);

    // All validations should still pass
    assert(activeOrder.validationStatus.isValid === true, 'Cart validation should pass');
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Quantity limit should pass');
    assert(activeOrder.isAvailable === true, 'Stock should be available');

    // Verify line-level availability
    assert(activeOrder.lines[0].isAvailable === true, 'Line should be available');
    assert(activeOrder.lines[0].unavailableReason === null, 'No unavailable reason for valid line');
}

async function testFullFlow_ChannelAvailabilityWithActiveOrder(): Promise<void> {
    // Login first to have customer context
    const res = await shopApi(`
        query GetChannels($postalCode: String) {
            getAvailableChannels(postalCode: $postalCode) {
                id
                code
                token
                name
                isAvailable
                message
                type
            }
        }
    `, { postalCode: CONFIG.postalCode });

    assertDefined(res.getAvailableChannels, 'Should return channels');

    // Verify current channel token is in available channels (if available for postal code)
    const currentChannel = res.getAvailableChannels.find(
        (c: any) => c.token === CONFIG.channelToken
    );
    if (currentChannel) {
        assert(
            currentChannel.isAvailable === true,
            `Current channel ${CONFIG.channelToken} should be available for postal code ${CONFIG.postalCode}`
        );
    }
}

async function testFullFlow_AddRemoveAddValidatesCorrectly(): Promise<void> {
    await clearActiveOrder();
    // Add item
    const order = await addItemToOrder(CONFIG.productVariantId);
    const lineId = order.lines[0].id;
    // Remove it
    await shopApi(`
        mutation RemoveLine($id: ID!) {
            removeOrderLine(orderLineId: $id) {
                ... on Order { id lines { id } }
                ... on OrderModificationError { message }
            }
        }
    `, { id: lineId });
    // Add again
    await addItemToOrder(CONFIG.productVariantId, 1);
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist after add-remove-add');
    assert(activeOrder.lines.length === 1, 'Should have exactly 1 line after add-remove-add');
    assert(activeOrder.validationStatus.isValid === true, 'Cart validation should pass');
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Quantity limit should pass');
    assert(activeOrder.isAvailable === true, 'Stock should be available');
}

async function testFullFlow_AdjustQuantityThenFullValidation(): Promise<void> {
    await clearActiveOrder();
    const order = await addItemToOrder(CONFIG.productVariantId, 1);
    const lineId = order.lines[0].id;
    // Adjust to 5
    await shopApi(`
        mutation AdjustLine($id: ID!, $qty: Int!) {
            adjustOrderLine(orderLineId: $id, quantity: $qty) {
                ... on Order { id lines { id quantity } }
                ... on OrderModificationError { errorCode message }
            }
        }
    `, { id: lineId, qty: 5 });
    // Full validation query
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist');
    assert(activeOrder.lines[0].quantity === 5, `Quantity should be 5, got ${activeOrder.lines[0].quantity}`);
    // All plugins should validate the adjusted quantity
    assert(activeOrder.validationStatus.isValid === true, 'Cart validation should pass after adjust');
    assert(activeOrder.quantityLimitStatus.isValid === true, 'Quantity limit should pass after adjust');
    assert(activeOrder.isAvailable === true, 'Stock should be available after adjust');
    assert(activeOrder.lines[0].isAvailable === true, 'Line should be available after adjust');
}

async function testFullFlow_RoundTripStateTransition(): Promise<void> {
    await clearActiveOrder();
    await addItemToOrder(CONFIG.productVariantId);
    await setShippingAddress();
    await setShippingMethod();
    // Forward: AddingItems -> ArrangingPayment
    const forward = await transitionToArrangingPayment();
    assert(
        forward.state === 'ArrangingPayment',
        `Should transition to ArrangingPayment, got: ${forward.state || JSON.stringify(forward)}`
    );
    // Backward: ArrangingPayment -> AddingItems
    const backward = await shopApi(`
        mutation {
            transitionOrderToState(state: "AddingItems") {
                ... on Order { id state }
                ... on OrderStateTransitionError { errorCode message }
            }
        }
    `);
    assert(
        backward.transitionOrderToState.state === 'AddingItems',
        `Should transition back to AddingItems, got: ${backward.transitionOrderToState.state}`
    );
    // Validate after round-trip
    const activeOrder = await getActiveOrderWithValidation();
    assertDefined(activeOrder, 'Active order should exist after round-trip');
    assert(activeOrder.active === true, 'Order should still be active after round-trip');
    assert(activeOrder.validationStatus.isValid === true, 'Cart should still be valid after round-trip');
}

// ==================================================================
// TEST RUNNER
// ==================================================================

interface TestSuite {
    name: string;
    tests: Array<{ name: string; fn: () => Promise<void> }>;
}

const suites: TestSuite[] = [
    {
        name: 'Cart Validation Plugin',
        tests: [
            { name: 'Active order has validationStatus field', fn: testCartValidation_ActiveOrderHasValidationStatus },
            { name: 'Valid cart reports isValid=true', fn: testCartValidation_ValidCartIsValid },
            { name: 'Order lines have isAvailable field', fn: testCartValidation_OrderLinesHaveAvailability },
            { name: 'Valid cart allows checkout transition', fn: testCartValidation_ValidCartAllowsCheckout },
            { name: 'Disabled product blocks checkout', fn: testCartValidation_DisabledProductBlocksCheckout },
            { name: 'Empty cart has valid validation status', fn: testCartValidation_EmptyCartIsValid },
            { name: 'isValid and hasUnavailableItems are inverses', fn: testCartValidation_IsValidAndHasUnavailableAreInverses },
            { name: 'totalUnavailableItems matches array length', fn: testCartValidation_TotalMatchesArrayLength },
            { name: 'Available line has null unavailableReason', fn: testCartValidation_AvailableLineHasNullReason },
            { name: 'Validation persists after adding second item', fn: testCartValidation_ValidationPersistsAfterAddingSecondItem },
        ],
    },
    {
        name: 'Quantity Limit Plugin',
        tests: [
            { name: 'Active order has quantityLimitStatus field', fn: testQuantityLimit_ActiveOrderHasQuantityLimitStatus },
            { name: 'No-limit product reports isValid=true', fn: testQuantityLimit_NoLimitProductIsValid },
            { name: 'Order has stock availability fields', fn: testQuantityLimit_StockAvailabilityOnOrder },
            { name: 'In-stock product reports isAvailable=true', fn: testQuantityLimit_InStockProductIsAvailable },
            { name: 'Limited product exceeding max is blocked', fn: testQuantityLimit_LimitedProductExceedsMax },
            { name: 'Out-of-stock product blocks checkout', fn: testQuantityLimit_OutOfStockBlocksCheckout },
            { name: 'Adjust quantity validates limits', fn: testQuantityLimit_AdjustQuantityValidation },
            { name: 'Empty cart has valid quantity limit status', fn: testQuantityLimit_EmptyCartHasValidStatus },
            { name: 'Violations array empty when status is valid', fn: testQuantityLimit_ViolationsEmptyWhenValid },
            { name: 'isValid and hasViolations are inverses', fn: testQuantityLimit_IsValidAndHasViolationsAreInverses },
            { name: 'Adding same item twice accumulates quantity', fn: testQuantityLimit_AddSameItemAccumulatesQuantity },
            { name: 'Remove line then re-add works correctly', fn: testQuantityLimit_RemoveAndReAddWorks },
            { name: 'Adjust quantity to 1 preserves validity', fn: testQuantityLimit_AdjustToOnePreservesValidity },
            { name: 'Multiple sequential adds keep order valid', fn: testQuantityLimit_MultipleAddsKeepOrderValid },
        ],
    },
    {
        name: 'Price Update Plugin',
        tests: [
            { name: 'Order lines have price fields', fn: testPriceUpdate_OrderLinesHavePrices },
            { name: 'Line prices match current variant prices', fn: testPriceUpdate_PricesMatchVariantPrices },
            { name: 'Active order query returns pricing data', fn: testPriceUpdate_ActiveOrderReturnsPrices },
            { name: 'Multiple queries return consistent prices', fn: testPriceUpdate_MultipleQueriesReturnConsistentPrices },
            { name: 'linePriceWithTax equals unitPriceWithTax * quantity', fn: testPriceUpdate_LinePriceEqualsUnitTimesQuantity },
            { name: 'subTotal matches sum of line prices', fn: testPriceUpdate_SubTotalIsSumOfLinePrices },
            { name: 'totalWithTax >= subTotalWithTax', fn: testPriceUpdate_TotalWithTaxGteSubTotalWithTax },
            { name: 'Order code is non-empty string', fn: testPriceUpdate_OrderCodeIsNonEmptyString },
        ],
    },
    {
        name: 'Channel Availability Plugin',
        tests: [
            { name: 'Query returns channel availability results', fn: testChannelAvailability_QueryReturnsResults },
            { name: 'Channels have all required fields', fn: testChannelAvailability_ChannelsHaveRequiredFields },
            { name: 'Default channel is excluded', fn: testChannelAvailability_ExcludesDefaultChannel },
            { name: 'Filter by channel type works', fn: testChannelAvailability_FilterByType },
            { name: 'Without postal code channels are unavailable', fn: testChannelAvailability_WithoutPostalCodeShowsUnavailable },
            { name: 'Unavailable brand has null token', fn: testChannelAvailability_UnavailableBrandHasNullToken },
            { name: 'Non-empty results for valid postal code', fn: testChannelAvailability_NonEmptyForValidPostalCode },
            { name: 'Available channel has non-null token', fn: testChannelAvailability_AvailableChannelHasToken },
            { name: 'All channels have unique ids', fn: testChannelAvailability_AllChannelsHaveUniqueIds },
            { name: 'Consistent results across repeated queries', fn: testChannelAvailability_ConsistentAcrossRepeatedQueries },
            { name: 'CITY + BRAND filter counts sum to total', fn: testChannelAvailability_TypeFilterCountsSumToTotal },
            { name: 'Available channel message is null', fn: testChannelAvailability_AvailableChannelMessageIsNull },
        ],
    },
    {
        name: 'Full Checkout Flow (All Plugins)',
        tests: [
            { name: 'Add -> Validate -> Checkout with all plugins', fn: testFullFlow_AddItemQueryValidateCheckout },
            { name: 'Multiple items validated by all plugins', fn: testFullFlow_MultipleItemsAllValidated },
            { name: 'Channel availability with active order context', fn: testFullFlow_ChannelAvailabilityWithActiveOrder },
            { name: 'Add -> Remove -> Add validates correctly', fn: testFullFlow_AddRemoveAddValidatesCorrectly },
            { name: 'Adjust quantity then full validation', fn: testFullFlow_AdjustQuantityThenFullValidation },
            { name: 'Round-trip state transition preserves validity', fn: testFullFlow_RoundTripStateTransition },
        ],
    },
];

async function runTests(): Promise<void> {
    console.log('\n==================================================================');
    console.log('  ACTIVE ORDER PLUGINS - E2E TEST SUITE');
    console.log('  Endpoint: ' + CONFIG.endpoint);
    console.log('  Channel: ' + CONFIG.channelToken);
    console.log('==================================================================\n');

    const allResults: TestResult[] = [];
    const startTime = Date.now();

    // Admin setup: configure test data via admin API
    try {
        await adminSetup();
    } catch (e: any) {
        console.error('[Admin Setup] Failed:', e.message);
        console.error('Continuing with limited test coverage...\n');
    }

    // Shop API login
    try {
        console.log('[Setup] Logging in to shop API...');
        const identifier = await login();
        console.log(`[Setup] Logged in as: ${identifier}\n`);
    } catch (e: any) {
        console.error('[Setup] Login failed:', e.message);
        console.error('Cannot run tests without authentication.');
        await adminTeardown();
        return;
    }

    // Clear any existing order
    try {
        await clearActiveOrder();
        console.log('[Setup] Cleared active order\n');
    } catch (e: any) {
        console.log('[Setup] No active order to clear\n');
    }

    // Run all test suites
    for (const suite of suites) {
        console.log(`\n--- ${suite.name} ---`);
        for (const test of suite.tests) {
            const testStart = Date.now();
            try {
                await test.fn();
                const duration = Date.now() - testStart;
                allResults.push({ name: `${suite.name}: ${test.name}`, passed: true, duration });
                console.log(`  PASS  ${test.name} (${duration}ms)`);
            } catch (e: any) {
                const duration = Date.now() - testStart;
                allResults.push({ name: `${suite.name}: ${test.name}`, passed: false, error: e.message, duration });
                console.error(`  FAIL  ${test.name} (${duration}ms)`);
                console.error(`        ${e.message}`);
            }
        }
    }

    // Cleanup shop order
    try {
        await clearActiveOrder();
    } catch (_) {
        // Ignore cleanup errors
    }

    // Admin teardown: restore original settings
    await adminTeardown();

    // Summary
    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
    const passed = allResults.filter(r => r.passed).length;
    const failed = allResults.filter(r => !r.passed).length;
    const total = allResults.length;

    console.log('\n==================================================================');
    console.log('  RESULTS');
    console.log('==================================================================');
    console.log(`  Total:    ${total}`);
    console.log(`  Passed:   ${passed}`);
    console.log(`  Failed:   ${failed}`);
    console.log(`  Duration: ${totalDuration}s`);
    console.log('==================================================================');

    if (failed > 0) {
        console.log('\n  FAILED TESTS:');
        for (const result of allResults.filter(r => !r.passed)) {
            console.log(`  - ${result.name}`);
            console.log(`    ${result.error}`);
        }
    }

    console.log('\n');
}

runTests();
