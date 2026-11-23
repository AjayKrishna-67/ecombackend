import * as crypto from 'crypto';
import { mergeConfig, TransactionalConnection, VendureConfig } from '@vendure/core';
import {
    createTestEnvironment,
    MysqlInitializer,
    registerInitializer,
    SimpleGraphQLClient,
    testConfig,
} from '@vendure/testing';
import gql from 'graphql-tag';
import { createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RazorpayPlugin } from '../razorpay.plugin';
import { RazorpayWebhookService } from '../service/razorpay-webhook.service';
import { initialData } from './fixtures/initial-data';

/**
 * Race + load test for the app-path / webhook double-write (CEO D8) and the
 * Razorpay fetch cap (E2-R1), on REAL MySQL row locks. sql.js has no row locks,
 * so the regular e2e suite cannot exercise either.
 *
 * Opt-in: needs a THROWAWAY MySQL (never the .env database). Example:
 *   docker run -d --name rzp-race-mysql -e MYSQL_ROOT_PASSWORD=<pw> \
 *     -p 127.0.0.1:3317:3306 --tmpfs /var/lib/mysql mysql:8.0
 *   RAZORPAY_RACE_MYSQL_PORT=3317 RAZORPAY_RACE_MYSQL_PASSWORD=<pw> bun run test:e2e
 *
 * No messages leave the machine: only the Razorpay plugin is loaded (no SMS /
 * WhatsApp / email plugins), the Razorpay SDK is faked, the order-placed webhook
 * URL is blanked, and any non-localhost fetch fails the run.
 */

const MYSQL_PORT = process.env.RAZORPAY_RACE_MYSQL_PORT;
const MYSQL_PASSWORD = process.env.RAZORPAY_RACE_MYSQL_PASSWORD;
const isEnabled = !!MYSQL_PORT && !!MYSQL_PASSWORD;
const API_PORT = 3057;
const KEYS = { key_id: 'rzp_test_race', key_secret: 'race_key_secret', webhook_secret: 'race_webhook_secret' };
const RACE_ROUNDS = 20;
const LOAD_CHECKOUTS = 50;
const STALLED_CHECKOUTS = 10;

// --- No outbound messages: blank the only outgoing hook, switch off Vendure's
// anonymous usage telemetry, and refuse any non-local network call. ---
process.env.ORDER_PLACED_WEBHOOK_URL = '';
process.env.VENDURE_DISABLE_TELEMETRY = 'true';
const blockedUrls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
        blockedUrls.push(url);
        throw new Error(`Blocked outbound request in test: ${url}`);
    }
    return realFetch(input, init);
}) as typeof fetch;

// --- Fake Razorpay with realistic, random network latency. ---
const rzp = vi.hoisted(() => ({
    orderSeq: 0,
    orders: new Map<string, { id: string; amount: number; created_at: number }>(),
    payments: new Map<string, { id: string; order_id: string; status: string; amount: number; created_at: number }>(),
    /** Payment ids whose app-side fetch should hang (simulated Razorpay stall). */
    stalledFetches: new Set<string>(),
    maxLatencyMs: 150,
}));
vi.mock('razorpay', () => {
    const latency = () => new Promise(resolve => setTimeout(resolve, Math.random() * rzp.maxLatencyMs));
    return {
        default: class FakeRazorpay {
            orders = {
                create: async (input: { amount: number; currency: string }) => {
                    await latency();
                    const order = { id: `order_race_${++rzp.orderSeq}`, amount: input.amount, currency: input.currency, created_at: Math.floor(Date.now() / 1000) };
                    rzp.orders.set(order.id, order);
                    return { ...order, status: 'created' };
                },
                fetch: async (id: string) => {
                    await latency();
                    const isPaid = [...rzp.payments.values()].some(p => p.order_id === id && p.status === 'captured');
                    return { ...rzp.orders.get(id), status: isPaid ? 'paid' : 'attempted' };
                },
                fetchPayments: async (id: string) => {
                    await latency();
                    return { items: [...rzp.payments.values()].filter(p => p.order_id === id) };
                },
            };
            payments = {
                fetch: async (id: string) => {
                    if (rzp.stalledFetches.has(id)) {
                        await new Promise(resolve => setTimeout(resolve, 12_000));
                    }
                    await latency();
                    const payment = rzp.payments.get(id);
                    if (!payment) {
                        throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
                    }
                    return payment;
                },
            };
        },
    };
});

const SHOP_URL = `http://localhost:${API_PORT}/shop-api`;

function buildConfig(): Required<VendureConfig> {
    const config = mergeConfig(testConfig, {
        plugins: [RazorpayPlugin],
        apiOptions: { port: API_PORT },
        customFields: {
            Order: [
                { name: 'razorpayOrderId', type: 'string', public: false, nullable: true },
                { name: 'razorpayPaymentId', type: 'string', public: false, nullable: true },
                { name: 'isPaymentWindowOpen', type: 'boolean', defaultValue: false, public: false },
            ],
        },
    }) as Required<VendureConfig>;
    // Same pool size as production (vendure-config.ts:363).
    config.dbConnectionOptions = {
        type: 'mysql',
        host: '127.0.0.1',
        port: Number(MYSQL_PORT),
        username: 'root',
        password: MYSQL_PASSWORD,
        database: 'placeholder',
        synchronize: true,
        logging: false,
        extra: { connectionLimit: 30 },
    } as any;
    return config;
}

const CREATE_PRODUCT = gql`mutation ($input: CreateProductInput!) { createProduct(input: $input) { id } }`;
const CREATE_VARIANTS = gql`mutation ($input: [CreateProductVariantInput!]!) { createProductVariants(input: $input) { id } }`;
const CREATE_PAYMENT_METHOD = gql`mutation ($input: CreatePaymentMethodInput!) { createPaymentMethod(input: $input) { id } }`;
const VARIANT_STOCK = gql`query ($id: ID!) { productVariant(id: $id) { stockAllocated } }`;
const ORDER_PAYMENTS = gql`query ($id: ID!) { order(id: $id) { state payments { state amount transactionId } } }`;
const ORDER_HISTORY = gql`query ($id: ID!) { order(id: $id) { history(options: { take: 50 }) { items { type data } } } }`;
const ADD_ITEM = gql`mutation ($v: ID!) { addItemToOrder(productVariantId: $v, quantity: 1) { ... on Order { id totalWithTax } ... on ErrorResult { errorCode message } } }`;
const SET_CUSTOMER = gql`mutation ($input: CreateCustomerInput!) { setCustomerForOrder(input: $input) { ... on Order { id } ... on ErrorResult { errorCode message } } }`;
const SET_ADDRESS = gql`mutation ($input: CreateAddressInput!) { setOrderShippingAddress(input: $input) { ... on Order { id } ... on ErrorResult { errorCode message } } }`;
const ELIGIBLE_SHIPPING = gql`query { eligibleShippingMethods { id } }`;
const SET_SHIPPING = gql`mutation ($ids: [ID!]!) { setOrderShippingMethod(shippingMethodId: $ids) { ... on Order { id } ... on ErrorResult { errorCode message } } }`;
const GENERATE = gql`mutation ($id: ID!) { generateRazorpayOrderId(orderId: $id) { success razorpayOrderId errorMessage } }`;
const ADD_PAYMENT = gql`
    mutation ($input: PaymentInput!) {
        addPaymentToOrder(input: $input) {
            ... on Order { state }
            ... on PaymentDeclinedError { errorCode paymentErrorMessage }
            ... on ErrorResult { errorCode message }
        }
    }
`;

interface Checkout {
    client: SimpleGraphQLClient;
    orderId: string;
    total: number;
    razorpayOrderId: string;
    razorpayPaymentId: string;
}

interface Timed<T> {
    value?: T;
    error?: string;
    ms: number;
}

async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
    const start = performance.now();
    try {
        return { value: await work(), ms: performance.now() - start };
    } catch (e: any) {
        return { error: e?.message ?? String(e), ms: performance.now() - start };
    }
}

function percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function signCheckout(razorpayOrderId: string, razorpayPaymentId: string): string {
    return crypto.createHmac('sha256', KEYS.key_secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
}

type PaymentEvent = 'payment.captured' | 'payment.authorized';

function signedWebhook(checkout: Checkout, event: PaymentEvent): { body: any; rawBody: string; signature: string } {
    const status = event === 'payment.captured' ? 'captured' : 'authorized';
    const body = {
        event,
        payload: { payment: { entity: { id: checkout.razorpayPaymentId, order_id: checkout.razorpayOrderId, amount: checkout.total, status, notes: {} } } },
    };
    const rawBody = JSON.stringify(body);
    return { body, rawBody, signature: crypto.createHmac('sha256', KEYS.webhook_secret).update(rawBody).digest('hex') };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

(isEnabled ? describe : describe.skip)('Razorpay app path vs webhook on real MySQL (race + load)', () => {
    if (isEnabled) {
        registerInitializer('mysql', new MysqlInitializer());
    }
    const config = buildConfig();
    const { server, adminClient } = createTestEnvironment(config);
    let variantId: string;
    let webhookService: RazorpayWebhookService;
    let checkoutSeq = 0;

    /** One guest session taken all the way to tap-Pay, with Razorpay holding a captured payment for it. */
    async function prepareCheckout(): Promise<Checkout> {
        const n = ++checkoutSeq;
        const client = new SimpleGraphQLClient(config, SHOP_URL);
        const { addItemToOrder } = await client.query(ADD_ITEM, { v: variantId });
        await client.query(SET_CUSTOMER, { input: { emailAddress: `race${n}@example.com`, firstName: 'Race', lastName: `Guest${n}` } });
        await client.query(SET_ADDRESS, { input: { streetLine1: `${n} Test Street`, countryCode: 'IN' } });
        const { eligibleShippingMethods } = await client.query(ELIGIBLE_SHIPPING);
        await client.query(SET_SHIPPING, { ids: [eligibleShippingMethods[0].id] });
        const { generateRazorpayOrderId } = await client.query(GENERATE, { id: addItemToOrder.id });
        expect(generateRazorpayOrderId.success).toBe(true);
        const razorpayPaymentId = `pay_race_${n}`;
        rzp.payments.set(razorpayPaymentId, {
            id: razorpayPaymentId,
            order_id: generateRazorpayOrderId.razorpayOrderId,
            status: 'captured',
            amount: addItemToOrder.totalWithTax,
            created_at: Math.floor(Date.now() / 1000),
        });
        return { client, orderId: addItemToOrder.id, total: addItemToOrder.totalWithTax, razorpayOrderId: generateRazorpayOrderId.razorpayOrderId, razorpayPaymentId };
    }

    function appPays(checkout: Checkout) {
        return checkout.client.query(ADD_PAYMENT, {
            input: {
                method: 'razorpay-payment',
                metadata: {
                    razorpayOrderId: checkout.razorpayOrderId,
                    razorpayPaymentId: checkout.razorpayPaymentId,
                    razorpaySignature: signCheckout(checkout.razorpayOrderId, checkout.razorpayPaymentId),
                },
            },
        });
    }

    function webhookArrives(checkout: Checkout, event: PaymentEvent = 'payment.captured') {
        const { body, rawBody, signature } = signedWebhook(checkout, event);
        return webhookService.processWebhook(signature, body, rawBody);
    }

    async function stockAllocated(): Promise<number> {
        const { productVariant } = await adminClient.query(VARIANT_STOCK, { id: variantId });
        return productVariant.stockAllocated;
    }

    /** Exactly one Settled payment for the Razorpay id, and the order placed. */
    async function expectPaidOnce(checkout: Checkout) {
        const { order } = await adminClient.query(ORDER_PAYMENTS, { id: checkout.orderId });
        const settled = order.payments.filter((p: any) => p.transactionId === checkout.razorpayPaymentId);
        return { state: order.state, settledCount: settled.length, amount: settled[0]?.amount };
    }

    async function mysqlStatus(names: string[]): Promise<Record<string, number>> {
        const conn = await createConnection({ host: '127.0.0.1', port: Number(MYSQL_PORT), user: 'root', password: MYSQL_PASSWORD });
        const [rows] = await conn.query(`SHOW GLOBAL STATUS WHERE Variable_name IN (${names.map(() => '?').join(',')})`, names);
        await conn.end();
        return Object.fromEntries((rows as any[]).map(r => [r.Variable_name, Number(r.Value)]));
    }

    /** Who is waiting on whom right now: blocked statement, the lock it wants, and the blocking statement. */
    async function lockWaitSnapshot() {
        const conn = await createConnection({ host: '127.0.0.1', port: Number(MYSQL_PORT), user: 'root', password: MYSQL_PASSWORD });
        const [rows] = await conn.query(`
            SELECT r.trx_query AS waiting_query, wl.OBJECT_NAME AS on_table, wl.INDEX_NAME AS on_index,
                   wl.LOCK_TYPE AS lock_type, wl.LOCK_MODE AS wanted_mode, bl.LOCK_MODE AS held_mode,
                   b.trx_query AS blocking_query, b.trx_started AS blocking_since
            FROM performance_schema.data_lock_waits w
            JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
            JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID
            JOIN performance_schema.data_locks wl ON wl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
            JOIN performance_schema.data_locks bl ON bl.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID
            LIMIT 5`);
        const [open] = await conn.query(`SELECT COUNT(*) AS open_trx, SUM(trx_rows_locked) AS rows_locked FROM information_schema.innodb_trx`);
        await conn.end();
        return { waits: rows, open };
    }

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        const { createProduct } = await adminClient.query(CREATE_PRODUCT, {
            input: { translations: [{ languageCode: 'en', name: 'Onion', slug: 'onion', description: 'race' }] },
        });
        const { createProductVariants } = await adminClient.query(CREATE_VARIANTS, {
            // trackInventory TRUE so every placed order allocates stock: a double placement shows up as a double allocation.
            input: [{ productId: createProduct.id, sku: 'ONION-1KG', price: 4000, stockOnHand: 100000, trackInventory: 'TRUE', translations: [{ languageCode: 'en', name: 'Onion 1kg' }] }],
        });
        variantId = createProductVariants[0].id;
        await adminClient.query(CREATE_PAYMENT_METHOD, {
            input: {
                code: 'razorpay-payment',
                enabled: true,
                handler: { code: 'razorpay-payment', arguments: [{ name: 'config', value: JSON.stringify(KEYS) }] },
                translations: [{ languageCode: 'en', name: 'Razorpay' }],
            },
        });
        webhookService = server.app.get(RazorpayWebhookService);
        expect(server.app.get(TransactionalConnection)).toBeDefined();
    }, 300_000);

    afterAll(async () => {
        await server.destroy();
        globalThis.fetch = realFetch;
    });

    it(`race: app call and webhook for the same payment at the same instant, ${RACE_ROUNDS} rounds → one payment, one allocation`, async () => {
        const stockBefore = await stockAllocated();
        const outcomes: Record<string, number> = {};
        const problems: string[] = [];
        for (let round = 0; round < RACE_ROUNDS; round++) {
            const checkout = await prepareCheckout();
            // Random head start for either side, so both orderings and true overlap occur.
            const [app, hook] = await Promise.all([
                sleep(Math.random() * 40).then(() => timed(() => appPays(checkout))),
                sleep(Math.random() * 40).then(() => timed(() => webhookArrives(checkout))),
            ]);
            const appOutcome = app.error
                ? `app threw: ${app.error}`
                : app.value.addPaymentToOrder.state ?? app.value.addPaymentToOrder.paymentErrorMessage ?? app.value.addPaymentToOrder.errorCode;
            outcomes[`app=${appOutcome} | webhook=${hook.error ? `threw: ${hook.error}` : hook.value}`] =
                (outcomes[`app=${appOutcome} | webhook=${hook.error ? `threw: ${hook.error}` : hook.value}`] ?? 0) + 1;
            const actual = await expectPaidOnce(checkout);
            if (actual.state !== 'PaymentSettled' || actual.settledCount !== 1) {
                problems.push(`round ${round}: state=${actual.state} payments=${actual.settledCount}`);
            }
            // Whoever records the payment, the app must see its order placed, or it
            // stays on the checkout page although the customer paid (order 64574).
            if (appOutcome !== 'PaymentSettled') {
                problems.push(`round ${round}: app saw ${appOutcome}`);
            }
        }
        const allocatedDelta = (await stockAllocated()) - stockBefore;
        console.log('\n[RACE] outcomes per round:', JSON.stringify(outcomes, null, 2));
        console.log(`[RACE] stockAllocated delta = ${allocatedDelta} (expected ${RACE_ROUNDS}); problems: ${problems.length ? problems.join('; ') : 'none'}`);
        expect(problems).toEqual([]);
        expect(allocatedDelta).toBe(RACE_ROUNDS);
        expect(blockedUrls).toEqual([]);
    }, 300_000);

    it(`two webhooks: payment.authorized and payment.captured for the same payment at once, ${RACE_ROUNDS} rounds → one Settlement history entry (order 64572)`, async () => {
        const problems: string[] = [];
        for (let round = 0; round < RACE_ROUNDS; round++) {
            const checkout = await prepareCheckout();
            await Promise.all([webhookArrives(checkout, 'payment.authorized'), webhookArrives(checkout)]);
            const actual = await expectPaidOnce(checkout);
            const { order } = await adminClient.query(ORDER_HISTORY, { id: checkout.orderId });
            const settlementEntries = order.history.items.filter((h: any) => h.data?.webhookEvent === 'Settlement').length;
            if (actual.state !== 'PaymentSettled' || actual.settledCount !== 1 || settlementEntries !== 1) {
                problems.push(`round ${round}: state=${actual.state} payments=${actual.settledCount} settlementEntries=${settlementEntries}`);
            }
        }
        console.log(`\n[TWO-WEBHOOKS] problems: ${problems.length ? problems.join('; ') : 'none'}`);
        expect(problems).toEqual([]);
        expect(blockedUrls).toEqual([]);
    }, 300_000);

    it(`load: ${LOAD_CHECKOUTS} checkouts paying at once (app + webhook each = ${LOAD_CHECKOUTS * 2} concurrent operations)`, async () => {
        const checkouts: Checkout[] = [];
        for (let i = 0; i < LOAD_CHECKOUTS; i += 10) {
            checkouts.push(...(await Promise.all(Array.from({ length: Math.min(10, LOAD_CHECKOUTS - i) }, () => prepareCheckout()))));
        }
        const stockBefore = await stockAllocated();
        const statusBefore = await mysqlStatus(['Innodb_row_lock_waits', 'Innodb_row_lock_time']);
        const wallStart = performance.now();
        const results = await Promise.all(
            checkouts.flatMap(checkout => [timed(() => appPays(checkout)), timed(() => webhookArrives(checkout))]),
        );
        const wallMs = Math.round(performance.now() - wallStart);
        const statusAfter = await mysqlStatus(['Innodb_row_lock_waits', 'Innodb_row_lock_time', 'Innodb_row_lock_time_max', 'Max_used_connections', 'Threads_connected']);
        const appTimes = results.filter((_, i) => i % 2 === 0).map(r => r.ms);
        const hookTimes = results.filter((_, i) => i % 2 === 1).map(r => r.ms);
        const thrown = results.filter(r => r.error).map(r => r.error);
        const appNotPlaced = results.filter((r, i) => i % 2 === 0 && !r.error && r.value.addPaymentToOrder.state !== 'PaymentSettled');
        const placed = await Promise.all(checkouts.map(c => expectPaidOnce(c)));
        const notPaidOnce = placed.filter(p => p.state !== 'PaymentSettled' || p.settledCount !== 1);
        const allocatedDelta = (await stockAllocated()) - stockBefore;
        console.log(`\n[LOAD] ${LOAD_CHECKOUTS} checkouts, ${results.length} concurrent operations, wall ${wallMs} ms`);
        console.log(`[LOAD] app addPaymentToOrder ms: p50=${percentile(appTimes, 50)} p95=${percentile(appTimes, 95)} max=${percentile(appTimes, 100)}`);
        console.log(`[LOAD] webhook settle ms:       p50=${percentile(hookTimes, 50)} p95=${percentile(hookTimes, 95)} max=${percentile(hookTimes, 100)}`);
        console.log(`[LOAD] MySQL row-lock waits: ${statusAfter.Innodb_row_lock_waits - statusBefore.Innodb_row_lock_waits}, lock wait time ${statusAfter.Innodb_row_lock_time - statusBefore.Innodb_row_lock_time} ms (max single ${statusAfter.Innodb_row_lock_time_max} ms); max DB connections used ${statusAfter.Max_used_connections}`);
        console.log(`[LOAD] thrown: ${thrown.length}; orders not paid exactly once: ${notPaidOnce.length}; stockAllocated delta ${allocatedDelta} of ${LOAD_CHECKOUTS} placements`);
        console.log(`[LOAD] app calls that did not see their order placed: ${appNotPlaced.length}`);
        expect(thrown).toEqual([]);
        expect(notPaidOnce).toEqual([]);
        expect(appNotPlaced).toEqual([]);
        // Never MORE than one allocation per order (no double placement). Vendure core
        // can record FEWER under parallel checkouts of one variant: StockLevelService
        // .updateStockAllocatedForLocation is read-then-write (stock-level.service.js:109-118),
        // so concurrent transactions overwrite each other's increment. Pre-existing core
        // behavior, not PR-1; the sequential race test above asserts the exact count.
        expect(allocatedDelta).toBeLessThanOrEqual(LOAD_CHECKOUTS);
        expect(blockedUrls).toEqual([]);
    }, 300_000);

    it(`stall: Razorpay hangs for ${STALLED_CHECKOUTS} app calls while ${STALLED_CHECKOUTS} normal checkouts pay → cap at 10 s, store keeps serving`, async () => {
        const stalled = await Promise.all(Array.from({ length: STALLED_CHECKOUTS }, () => prepareCheckout()));
        const normal = await Promise.all(Array.from({ length: STALLED_CHECKOUTS }, () => prepareCheckout()));
        stalled.forEach(c => rzp.stalledFetches.add(c.razorpayPaymentId));
        const stalledCalls = stalled.map(c => timed(() => appPays(c)));
        await sleep(500); // the stalled requests now hold their DB connections
        const normalCalls = Promise.all(normal.map(c => timed(() => appPays(c))));
        await sleep(3_000);
        console.log('\n[STALL] lock waits 3.5 s into the stall:', JSON.stringify(await lockWaitSnapshot(), null, 1));
        const normalResults = await normalCalls;
        console.log('[STALL] normal app call outcomes:', JSON.stringify(normalResults.map(r => r.error ?? r.value?.addPaymentToOrder?.state ?? r.value?.addPaymentToOrder?.paymentErrorMessage ?? r.value?.addPaymentToOrder?.message)));
        const stalledResults = await Promise.all(stalledCalls);
        // The webhook still places every stalled order.
        await Promise.all(stalled.map(c => webhookArrives(c)));
        const stalledMs = stalledResults.map(r => r.ms);
        const normalMs = normalResults.map(r => r.ms);
        const stalledMessages = [...new Set(stalledResults.map(r => r.value?.addPaymentToOrder?.paymentErrorMessage ?? r.error))];
        const placed = await Promise.all([...stalled, ...normal].map(c => expectPaidOnce(c)));
        console.log(`\n[STALL] stalled app calls ms: min=${percentile(stalledMs, 0)} max=${percentile(stalledMs, 100)}; result: ${stalledMessages.join(', ')}`);
        console.log(`[STALL] normal app calls during the stall ms: p50=${percentile(normalMs, 50)} p95=${percentile(normalMs, 95)} max=${percentile(normalMs, 100)}`);
        console.log(`[STALL] orders paid exactly once: ${placed.filter(p => p.state === 'PaymentSettled' && p.settledCount === 1).length}/${placed.length}`);
        expect(stalledMessages).toEqual(['Razorpay did not respond']);
        expect(Math.min(...stalledMs)).toBeGreaterThanOrEqual(9_900);
        expect(Math.max(...stalledMs)).toBeLessThan(13_000);
        expect(percentile(normalMs, 95)).toBeLessThan(5_000);
        expect(placed.every(p => p.state === 'PaymentSettled' && p.settledCount === 1)).toBe(true);
        expect(blockedUrls).toEqual([]);
    }, 300_000);
});
