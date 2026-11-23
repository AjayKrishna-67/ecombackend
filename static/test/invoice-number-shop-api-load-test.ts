// Invoice Number Plugin — Shop API Load Test
// Places N orders sequentially via the real shop-api flow and verifies
// every order gets a unique, contiguous invoice number.
//
// Usage:
//   ORDERS=5  npx ts-node static/test/invoice-number-shop-api-load-test.ts
//   ORDERS=100 npx ts-node static/test/invoice-number-shop-api-load-test.ts

const SHOP = 'http://localhost:80/shop-api';
const ADMIN = 'http://localhost:80/admin-api';
const CHANNEL = 'ind-madurai';
const ORDER_COUNT = Number(process.env.ORDERS ?? 100);

const AUTH_PHONE = '8056305724';
const AUTH_FIRST = 'SRIRAM';
const AUTH_LAST = 'Mr.';
const AUTH_EMAIL = '8056305724@kaikani.com';

const ADMIN_USER = 'sriram';
const ADMIN_PASS = 'superadmin';

const VARIANT_ID = process.env.VARIANT_ID ?? '62';
const SHIPPING_METHOD_ID = process.env.SHIPPING_METHOD_ID ?? '20';
const POSTAL_CODE = process.env.POSTAL_CODE ?? '625001';
const PAYMENT_METHOD = 'offline';

// ─── HTTP helpers ───────────────────────────────────────────────────────

let shopToken: string | null = null;
let adminToken: string | null = null;

async function shop(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'vendure-token': CHANNEL,
    };
    if (shopToken) headers['Authorization'] = `Bearer ${shopToken}`;
    const res = await fetch(SHOP, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    const newAuth = res.headers.get('vendure-auth-token');
    if (newAuth) shopToken = newAuth;
    const json: any = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
}

async function admin(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'vendure-token': CHANNEL,
    };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const res = await fetch(ADMIN, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    });
    const newAuth = res.headers.get('vendure-auth-token');
    if (newAuth) adminToken = newAuth;
    const json: any = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data;
}

// ─── Auth ───────────────────────────────────────────────────────────────

async function loginAdmin(): Promise<void> {
    const res = await admin(
        `mutation { login(username: "${ADMIN_USER}", password: "${ADMIN_PASS}") {
            ... on CurrentUser { identifier }
            ... on InvalidCredentialsError { message }
        }}`,
    );
    if (!res.login.identifier) throw new Error(`Admin login failed: ${res.login.message}`);
}

async function loginCustomer(): Promise<void> {
    // Log out first to detach from any previous session/active order.
    // Without this, the OTP auth may reuse the old session that's still
    // tied to a completed order, and addItemToOrder will fail with
    // "Order contents may only be modified when in AddingItems state".
    try {
        await shop(`mutation { logout { success } }`);
        shopToken = null;
    } catch { /* ignore — not logged in yet */ }

    const otpRes = await shop(`mutation { sendPhoneOtp(phoneNumber: "${AUTH_PHONE}") }`);
    const code = otpRes.sendPhoneOtp;
    if (!code) throw new Error('sendPhoneOtp returned no OTP');
    const res = await shop(
        `mutation Auth($code: String!) {
            authenticate(input: {
                phoneOtp: {
                    phoneNumber: "${AUTH_PHONE}"
                    code: $code
                    firstName: "${AUTH_FIRST}"
                    lastName: "${AUTH_LAST}"
                    emailAddress: "${AUTH_EMAIL}"
                }
            }) {
                __typename
                ... on CurrentUser { identifier }
                ... on InvalidCredentialsError { message }
            }
        }`,
        { code },
    );
    if (res.authenticate.__typename !== 'CurrentUser') {
        throw new Error(`Customer auth failed: ${JSON.stringify(res.authenticate)}`);
    }
}

// ─── Cleanup stuck active order ─────────────────────────────────────────

/** Terminal states — orders in these states are complete. Don't touch them. */
const TERMINAL_STATES = ['PaymentSettled', 'Delivered', 'Cancelled', 'Shipped', 'OutforDelivery'];

async function clearActiveOrder(): Promise<boolean> {
    const { activeOrder } = await shop(`query { activeOrder { id state lines { id } } }`);
    if (!activeOrder) return true;

    // Terminal state — order is done. Vendure still returns it as "active"
    // but addItemToOrder will create a new order. Nothing to clear.
    if (TERMINAL_STATES.includes(activeOrder.state)) return true;

    if (activeOrder.state === 'AddingItems') {
        for (const line of activeOrder.lines ?? []) {
            await shop(`mutation { removeOrderLine(orderLineId: "${line.id}") { ... on Order { id } ... on OrderModificationError { message } } }`);
        }
        return true;
    }

    // Stuck in ArrangingPayment or similar — try to go back
    const back = await shop(`mutation { transitionOrderToState(state: "AddingItems") { __typename ... on Order { id } ... on ErrorResult { message } } }`);
    if (back.transitionOrderToState.__typename === 'Order') {
        const refreshed = await shop(`query { activeOrder { lines { id } } }`);
        for (const line of refreshed.activeOrder?.lines ?? []) {
            await shop(`mutation { removeOrderLine(orderLineId: "${line.id}") { ... on Order { id } ... on OrderModificationError { message } } }`);
        }
        return true;
    }

    // Can't go back — cancel via admin
    try {
        await admin(`mutation { cancelOrder(input: { orderId: "${activeOrder.id}" }) { ... on Order { id } ... on ErrorResult { message } } }`);
        return true;
    } catch {
        return false;
    }
}

// ─── Place one order (exact production flow) ────────────────────────────

interface PlacedOrder { orderId: string; orderCode: string; ms: number; }

async function placeOrder(i: number): Promise<PlacedOrder> {
    const t = Date.now();

    // Force a fresh anonymous session so Vendure creates a new active order.
    // Vendure ties the active order to the session. After a completed order,
    // the session still references it. Logging out + re-authenticating gives
    // us a new session with no active order attached.
    //
    // We re-authenticate using the SAME OTP approach but Vendure's session
    // token rotation means we get a fresh session on each authenticate call.
    // The sendPhoneOtp call costs 1 SMS per order — unavoidable with the
    // shop-api flow for the same customer.
    await shop(`mutation { logout { success } }`).catch(() => {});
    shopToken = null;
    await loginCustomer();

    // 1. addItemToOrder
    const add = await shop(
        `mutation { addItemToOrder(productVariantId: "${VARIANT_ID}", quantity: 1) {
            __typename
            ... on Order { id code }
            ... on ErrorResult { errorCode message }
            ... on InsufficientStockError { message }
            ... on OrderInterceptorError { message interceptorError }
        }}`,
    );
    if (add.addItemToOrder.__typename !== 'Order') {
        throw new Error(`[${i}] addItemToOrder: ${JSON.stringify(add.addItemToOrder)}`);
    }
    const { id: orderId, code: orderCode } = add.addItemToOrder;

    // 2. setOrderShippingAddress
    const addr = await shop(
        `mutation { setOrderShippingAddress(input: {
            fullName: "Load Test ${i}"
            streetLine1: "123 Test St"
            city: "Madurai"
            postalCode: "${POSTAL_CODE}"
            countryCode: "IN"
            phoneNumber: "${AUTH_PHONE}"
        }) {
            __typename
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }}`,
    );
    if (addr.setOrderShippingAddress.__typename !== 'Order') {
        throw new Error(`[${i}] setOrderShippingAddress: ${JSON.stringify(addr.setOrderShippingAddress)}`);
    }

    // 3. setOrderShippingMethod
    const ship = await shop(
        `mutation { setOrderShippingMethod(shippingMethodId: ${SHIPPING_METHOD_ID}) {
            __typename
            ... on Order { id }
            ... on ErrorResult { errorCode message }
        }}`,
    );
    if (ship.setOrderShippingMethod.__typename !== 'Order') {
        throw new Error(`[${i}] setOrderShippingMethod: ${JSON.stringify(ship.setOrderShippingMethod)}`);
    }

    // 4. transitionOrderToState("ArrangingPayment")
    const trans = await shop(
        `mutation { transitionOrderToState(state: "ArrangingPayment") {
            __typename
            ... on Order { id state }
            ... on ErrorResult { errorCode message }
            ... on OrderStateTransitionError { message fromState toState }
        }}`,
    );
    if (trans.transitionOrderToState.__typename !== 'Order') {
        throw new Error(`[${i}] ArrangingPayment: ${JSON.stringify(trans.transitionOrderToState)}`);
    }

    // 5. addPaymentToOrder (real shop-api payment with "offline" method)
    const ts = Date.now();
    const pay = await shop(
        `mutation { addPaymentToOrder(input: {
            method: "${PAYMENT_METHOD}"
            metadata: {
                razorpayPaymentId: "pay_test_${i}_${ts}"
                razorpayOrderId: "order_test_${i}_${ts}"
                razorpaySignature: "sig_test_${i}_${ts}"
            }
        }) {
            __typename
            ... on Order { id code state }
            ... on PaymentFailedError { message }
            ... on PaymentDeclinedError { message paymentErrorMessage }
            ... on OrderPaymentStateError { message }
            ... on IneligiblePaymentMethodError { message }
            ... on NoActiveOrderError { message }
            ... on OrderStateTransitionError { message fromState toState }
        }}`,
    );
    if (pay.addPaymentToOrder.__typename !== 'Order') {
        throw new Error(`[${i}] addPaymentToOrder: ${JSON.stringify(pay.addPaymentToOrder)}`);
    }

    return { orderId, orderCode, ms: Date.now() - t };
}

// ─── Verify invoice numbers ─────────────────────────────────────────────

async function verify(orderCodes: string[]): Promise<boolean> {
    const take = Math.max(orderCodes.length * 2, 200);
    const res = await admin(
        `query($take: Int!) { orders(options: { take: $take, sort: { createdAt: DESC } }) {
            items { code customFields { invoiceNo } }
        }}`,
        { take },
    );
    const codeSet = new Set(orderCodes);
    const invoices: Array<{ code: string; inv: number | null }> = [];
    for (const o of res.orders.items) {
        if (codeSet.has(o.code)) {
            invoices.push({ code: o.code, inv: o.customFields?.invoiceNo ?? null });
        }
    }

    const missing = orderCodes.filter(c => !invoices.find(i => i.code === c));
    const noInv = invoices.filter(i => i.inv == null);
    const byInv = new Map<number, string[]>();
    for (const i of invoices) {
        if (i.inv == null) continue;
        const list = byInv.get(i.inv) ?? [];
        list.push(i.code);
        byInv.set(i.inv, list);
    }
    const dupes = [...byInv.entries()].filter(([, codes]) => codes.length > 1);
    const nums = [...byInv.keys()].sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
        if (!byInv.has(n)) gaps.push(n);
    }

    console.log('───────────────────────────────────────────────────────────────');
    console.log('  RESULTS');
    console.log('───────────────────────────────────────────────────────────────');
    console.log(`  Orders placed    : ${orderCodes.length}`);
    console.log(`  Fetched          : ${invoices.length}`);
    console.log(`  Missing from DB  : ${missing.length}`);
    console.log(`  No invoice #     : ${noInv.length}`);
    console.log(`  Invoice range    : ${nums[0]} → ${nums[nums.length - 1]}`);
    console.log(`  Duplicates       : ${dupes.length}`);
    console.log(`  Gaps             : ${gaps.length}`);
    if (dupes.length > 0) {
        console.log('  ── DUPLICATES ──');
        for (const [inv, codes] of dupes.slice(0, 10)) {
            console.log(`    #${inv} → ${codes.join(', ')}`);
        }
    }
    if (gaps.length > 0) {
        console.log(`  ── GAPS (first 10): ${gaps.slice(0, 10).join(', ')}`);
    }

    const pass = missing.length === 0 && noInv.length === 0 && dupes.length === 0 && gaps.length === 0;
    console.log(`\n  ${pass ? '✓ PASS' : '✗ FAIL'}`);
    return pass;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`\n  Invoice Number Load Test — ${ORDER_COUNT} orders via shop-api\n`);

    await loginAdmin();
    console.log('  ✓ Admin logged in');

    await loginCustomer();
    console.log('  ✓ Customer authenticated (1 OTP)');

    // Check active order state
    const { activeOrder: current } = await shop(`query { activeOrder { id state } }`);
    if (!current) {
        console.log('  ✓ No active order — clean slate');
    } else if (TERMINAL_STATES.includes(current.state)) {
        console.log(`  ✓ Active order ${current.id} is in terminal state (${current.state}) — will auto-create new`);
    } else {
        console.log(`  ⚠ Stuck active order: ${current.id} (state: ${current.state}) — clearing...`);
        const cleared = await clearActiveOrder();
        if (cleared) {
            console.log('  ✓ Cleared');
        } else {
            console.log(`  ✗ Could not clear order ${current.id}. Cancel it in admin UI, then re-run.`);
            process.exit(1);
        }
    }

    console.log(`\n  Placing ${ORDER_COUNT} orders...\n`);

    const placed: PlacedOrder[] = [];
    const failed: Array<{ i: number; err: string }> = [];
    const t0 = Date.now();

    for (let i = 1; i <= ORDER_COUNT; i++) {
        try {
            const order = await placeOrder(i);
            placed.push(order);
            if (i % 10 === 0 || i === ORDER_COUNT) {
                console.log(`    ${i}/${ORDER_COUNT}  (last: ${order.ms}ms)`);
            }
        } catch (err: any) {
            failed.push({ i, err: err.message });
            console.log(`    ${i}/${ORDER_COUNT}  FAILED: ${err.message.slice(0, 100)}`);
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n  Done in ${elapsed}s — ${placed.length} ok, ${failed.length} failed`);

    if (placed.length === 0) {
        console.log('  ✗ FAIL — no orders placed');
        process.exit(1);
    }

    console.log('  Waiting 2s for event handlers...');
    await new Promise(r => setTimeout(r, 2000));

    const pass = await verify(placed.map(p => p.orderCode));
    process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
export {};
