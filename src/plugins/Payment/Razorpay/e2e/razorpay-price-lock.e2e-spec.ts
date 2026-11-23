import * as crypto from 'crypto';
import {
    ID, Logger, mergeConfig, Order, OrderService, ProductVariantPrice, RequestContextService, TransactionalConnection,
} from '@vendure/core';
import { createTestEnvironment, registerInitializer, SimpleGraphQLClient, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AddonPriceCalculationStrategy } from '../../../Essentials/addon-group/strategies/addon-price-calculation.strategy';
import { PriceUpdateOrderEntityResolver } from '../../../Essentials/price-update/api/order-entity.resolver';
import { PriceUpdatePlugin, PriceUpdateService } from '../../../Essentials/price-update/price-update.plugin';
import { RazorpayPlugin } from '../razorpay.plugin';
import { RazorpayReconciliationService } from '../service/razorpay-reconciliation.service';
import { RazorpaySettlementService } from '../service/razorpay-settlement.service';
import { RazorpayWebhookService } from '../service/razorpay-webhook.service';
import { initialData } from './fixtures/initial-data';

/**
 * Price lock at Pay (PR-2), end to end on a real Vendure with only Razorpay faked.
 *
 * The incident: the customer tapped Pay for ₹1,450, an admin changed a price, the
 * price sync repriced the mid-payment order to ₹13,600, Razorpay captured ₹1,450,
 * and the order was stuck in ArrangingPayment with the money taken. These tests
 * prove the lock stops that, the settle-time safety net handles what is left, and
 * the existing behaviour around them (R-a..R-e, D21) still works.
 */

process.env.VENDURE_DISABLE_TELEMETRY = 'true';
process.env.ORDER_PLACED_WEBHOOK_URL = '';

const rzp = vi.hoisted(() => ({
    seq: 0,
    createCalls: 0,
    orders: new Map<string, { id: string; amount: number; created_at: number }>(),
    payments: new Map<string, { id: string; order_id: string; status: string; amount: number; created_at: number }>(),
}));
vi.mock('razorpay', () => ({
    default: class FakeRazorpay {
        orders = {
            create: async (input: { amount: number; currency: string }) => {
                rzp.createCalls++;
                const order = { id: `order_pl_${++rzp.seq}`, amount: input.amount, currency: input.currency, created_at: Math.floor(Date.now() / 1000) };
                rzp.orders.set(order.id, order);
                return { ...order, status: 'created' };
            },
            fetch: async (id: string) => {
                const isPaid = [...rzp.payments.values()].some(p => p.order_id === id && p.status === 'captured');
                return { ...rzp.orders.get(id), status: isPaid ? 'paid' : 'attempted', attempts: 1, amount_paid: 0, amount_due: 0 };
            },
            fetchPayments: async (id: string) => ({ items: [...rzp.payments.values()].filter(p => p.order_id === id) }),
        };
        payments = {
            fetch: async (id: string) => {
                const payment = rzp.payments.get(id);
                if (!payment) throw { statusCode: 400, error: { description: 'The id provided does not exist' } };
                return payment;
            },
        };
    },
}));

const KEYS = { key_id: 'rzp_test_pricelock', key_secret: 'pl_key_secret', webhook_secret: 'pl_webhook_secret' };
const PRICE = 145000; // ₹1,450 — the incident's quote
const API_PORT = 3060;

const dataDir = path.join(process.cwd(), 'src/plugins/Payment/Razorpay/e2e/__data__');
registerInitializer('sqljs', new SqljsInitializer(dataDir));

const config = mergeConfig(testConfig, {
    plugins: [RazorpayPlugin, PriceUpdatePlugin],
    apiOptions: { port: API_PORT },
    orderOptions: { orderItemPriceCalculationStrategy: new AddonPriceCalculationStrategy() },
    customFields: {
        Order: [
            { name: 'razorpayOrderId', type: 'string', public: false, nullable: true },
            { name: 'razorpayPaymentId', type: 'string', public: false, nullable: true },
            { name: 'isPaymentWindowOpen', type: 'boolean', defaultValue: false, public: false },
        ],
    },
});
const { server, adminClient } = createTestEnvironment(config);
const SHOP_URL = `http://localhost:${API_PORT}/shop-api`;

const Q = {
    createProduct: gql`mutation ($i: CreateProductInput!) { createProduct(input: $i) { id } }`,
    createVariants: gql`mutation ($i: [CreateProductVariantInput!]!) { createProductVariants(input: $i) { id } }`,
    createMethod: gql`mutation ($i: CreatePaymentMethodInput!) { createPaymentMethod(input: $i) { id } }`,
    order: gql`query ($id: ID!) { order(id: $id) { id code state totalWithTax
        lines { id quantity unitPriceWithTax }
        surcharges { sku description priceWithTax }
        payments { state amount transactionId }
        history(options: { take: 50, sort: { createdAt: DESC } }) { items { type data } } } }`,
    addItem: gql`mutation ($v: ID!, $q: Int!) { addItemToOrder(productVariantId: $v, quantity: $q) { ... on Order { id totalWithTax } ... on ErrorResult { errorCode message } } }`,
    setCustomer: gql`mutation ($i: CreateCustomerInput!) { setCustomerForOrder(input: $i) { ... on Order { id } ... on ErrorResult { errorCode message } } }`,
    setAddress: gql`mutation ($i: CreateAddressInput!) { setOrderShippingAddress(input: $i) { ... on Order { id totalWithTax } ... on ErrorResult { errorCode message } } }`,
    eligible: gql`query { eligibleShippingMethods { id } }`,
    setShipping: gql`mutation ($ids: [ID!]!) { setOrderShippingMethod(shippingMethodId: $ids) { ... on Order { id } ... on ErrorResult { errorCode message } } }`,
    generate: gql`mutation ($id: ID!) { generateRazorpayOrderId(orderId: $id) { success razorpayOrderId amount errorMessage } }`,
    cancel: gql`mutation ($id: ID!) { cancelRazorpayPayment(orderId: $id) { success reverted state errorMessage } }`,
    status: gql`query ($id: ID!) { getRazorpayOrderStatus(orderId: $id) { status amountPaid } }`,
    activeOrder: gql`query { activeOrder { id state totalWithTax lines { unitPriceWithTax } } }`,
    addPayment: gql`mutation ($i: PaymentInput!) { addPaymentToOrder(input: $i) {
        __typename ... on Order { state payments { state transactionId } } ... on ErrorResult { errorCode message } } }`,
};

describe('Price lock at Pay (e2e)', () => {
    let variantId: string;
    let seq = 0;

    const app = <T>(token: any): T => server.app.get(token);
    /** testConfig encodes ids as "T_5" in GraphQL; services and the DB use the raw id. */
    const dbId = (id: ID): string => String(id).replace(/^T_/, '');
    async function adminCtx() {
        return app<RequestContextService>(RequestContextService).create({ apiType: 'admin' });
    }

    /** Sets the variant's channel price directly (no price-change event), leaving carts stale. */
    async function setPriceSilently(price: number) {
        await app<TransactionalConnection>(TransactionalConnection).rawConnection
            .createQueryBuilder().update(ProductVariantPrice).set({ price }).where('variantId = :id', { id: dbId(variantId) }).execute();
    }

    /**
     * The shop's Order.lines read-time reprice. Called on the resolver itself: on
     * this test server the GraphQL field hook does not fire (the original resolver
     * behaves the same here), so the real function is exercised directly.
     */
    async function shopReadsLines(orderId: ID) {
        const shopCtx = await app<RequestContextService>(RequestContextService).create({ apiType: 'shop' });
        const entity = await app<TransactionalConnection>(TransactionalConnection).getRepository(shopCtx, Order)
            .findOne({ where: { id: dbId(orderId) } as any });
        await app<PriceUpdateOrderEntityResolver>(PriceUpdateOrderEntityResolver).lines(shopCtx, entity as Order);
    }

    async function order(id: ID) {
        return (await adminClient.query(Q.order, { id })).order;
    }

    /** A guest cart with one item, ready to tap Pay. */
    async function cart(quantity = 1) {
        const n = ++seq;
        const shop = new SimpleGraphQLClient(config as any, SHOP_URL);
        const { addItemToOrder } = await shop.query(Q.addItem, { v: variantId, q: quantity });
        await shop.query(Q.setCustomer, { i: { emailAddress: `lock${n}@example.com`, firstName: 'Lock', lastName: `Test${n}` } });
        await shop.query(Q.setAddress, { i: { streetLine1: `${n} Market Road`, countryCode: 'IN' } });
        const { eligibleShippingMethods } = await shop.query(Q.eligible);
        await shop.query(Q.setShipping, { ids: [eligibleShippingMethods[0].id] });
        return { shop, orderId: addItemToOrder.id as string };
    }

    async function tapPay(c: { shop: SimpleGraphQLClient; orderId: string }) {
        const { generateRazorpayOrderId } = await c.shop.query(Q.generate, { id: c.orderId });
        expect(generateRazorpayOrderId.success).toBe(true);
        return generateRazorpayOrderId as { razorpayOrderId: string; amount: number };
    }

    /** Razorpay captures `amount` for the Razorpay order, `ageMin` minutes ago. */
    function capture(razorpayOrderId: string, amount: number, ageMin = 1) {
        const id = `pay_pl_${++rzp.seq}`;
        rzp.payments.set(id, { id, order_id: razorpayOrderId, status: 'captured', amount, created_at: Math.floor((Date.now() - ageMin * 60_000) / 1000) });
        return id;
    }

    /** The app's call after the Razorpay checkout returns, signed the way Razorpay signs it. */
    async function appPays(shop: SimpleGraphQLClient, razorpayOrderId: string, paymentId: string, signature?: string) {
        const razorpaySignature = signature ?? crypto.createHmac('sha256', KEYS.key_secret).update(`${razorpayOrderId}|${paymentId}`).digest('hex');
        const { addPaymentToOrder } = await shop.query(Q.addPayment, {
            i: { method: 'razorpay-payment', metadata: { razorpayOrderId, razorpayPaymentId: paymentId, razorpaySignature } },
        });
        return addPaymentToOrder;
    }

    /** The order as a webhook job loads it before settling. */
    async function loadForSettle(orderId: ID) {
        return app<TransactionalConnection>(TransactionalConnection).getRepository(await adminCtx(), Order)
            .findOne({ where: { id: dbId(orderId) } as any, relations: ['payments', 'channels'] }) as Promise<Order>;
    }

    /** The webhook / reconciliation settle path, in the order's own channel. */
    async function settle(orderId: ID, loaded?: Order) {
        const settlement = app<RazorpaySettlementService>(RazorpaySettlementService);
        const ctx = await adminCtx();
        const client = await settlement.getRazorpayClientForCtx(ctx);
        return settlement.settleFromRazorpay(ctx, loaded ?? await loadForSettle(orderId), client, 'e2e');
    }

    /** Simulates drift the price lock cannot prevent (coupon, shipping) by adding a surcharge. */
    async function drift(orderId: ID, amount: number) {
        await app<OrderService>(OrderService).addSurchargeToOrder(await adminCtx(), dbId(orderId), {
            description: 'test drift', sku: 'TEST-DRIFT', listPrice: amount, listPriceIncludesTax: true,
        });
    }

    const notes = (o: any): string[] => o.history.items.filter((h: any) => h.type === 'ORDER_NOTE').map((h: any) => h.data.note);
    const hasAdjustment = (o: any) => o.surcharges.some((s: any) => s.sku === 'PRICE-LOCK-ADJ');

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        const { createProduct } = await adminClient.query(Q.createProduct, {
            i: { translations: [{ languageCode: 'en', name: 'Pears', slug: 'pears', description: 'e2e' }] },
        });
        const { createProductVariants } = await adminClient.query(Q.createVariants, {
            i: [{ productId: createProduct.id, sku: 'PEARS-HALF-KG', price: PRICE, stockOnHand: 1000, translations: [{ languageCode: 'en', name: 'Pears 1/2 kg' }] }],
        });
        variantId = createProductVariants[0].id;
        await adminClient.query(Q.createMethod, {
            i: { code: 'razorpay-payment', enabled: true, handler: { code: 'razorpay-payment', arguments: [{ name: 'config', value: JSON.stringify(KEYS) }] }, translations: [{ languageCode: 'en', name: 'Razorpay' }] },
        });
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    describe('price lock (the incident)', () => {
        it('R-a: a cart (AddingItems) still gets the new price from the sync and from a shop read', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            await setPriceSilently(150000);
            await app<PriceUpdateService>(PriceUpdateService).updatePricesForActiveOrder(await adminCtx(), dbId(c.orderId));
            expect((await order(c.orderId)).totalWithTax).toBe(150000);
            await setPriceSilently(160000);
            await shopReadsLines(c.orderId);
            expect((await order(c.orderId)).totalWithTax).toBe(160000);
        });

        it('an order being paid keeps its price: price sync, shop read and an address change do not reprice it', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            expect(quote.amount).toBe(PRICE);
            await setPriceSilently(1360000);
            await app<PriceUpdateService>(PriceUpdateService).updatePricesForActiveOrder(await adminCtx(), dbId(c.orderId));
            expect((await order(c.orderId)).totalWithTax).toBe(PRICE);
            await shopReadsLines(c.orderId);
            expect((await order(c.orderId)).totalWithTax).toBe(PRICE);
            await c.shop.query(Q.setAddress, { i: { streetLine1: 'Changed on the payment screen', countryCode: 'IN' } });
            const locked = await order(c.orderId);
            expect(locked.state).toBe('ArrangingPayment');
            expect(locked.totalWithTax).toBe(PRICE);
            expect(locked.lines[0].unitPriceWithTax).toBe(PRICE);
        });

        it('after the customer closes the payment page, the cart picks up the new price', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            await tapPay(c);
            await setPriceSilently(150000);
            const { cancelRazorpayPayment } = await c.shop.query(Q.cancel, { id: c.orderId });
            expect(cancelRazorpayPayment.reverted).toBe(true);
            await app<PriceUpdateService>(PriceUpdateService).updatePricesForActiveOrder(await adminCtx(), dbId(c.orderId));
            expect((await order(c.orderId)).totalWithTax).toBe(150000);
        });
    });

    describe('reprice at Pay', () => {
        it('a stale cart is repriced when the customer taps Pay, so Razorpay is asked for the fresh price', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            await setPriceSilently(150000); // no event: the cart still shows ₹1,450
            const quote = await tapPay(c);
            expect(quote.amount).toBe(150000);
            expect((await order(c.orderId)).totalWithTax).toBe(150000);
        });

        it('if repricing fails, checkout continues at the stored total and logs a warning (D19)', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            await setPriceSilently(150000);
            const orderService = app<OrderService>(OrderService);
            const spy = vi.spyOn(orderService, 'applyPriceAdjustments').mockRejectedValueOnce(new Error('no-active-tax-zone'));
            const warn = vi.spyOn(Logger, 'warn');
            const quote = await tapPay(c);
            spy.mockRestore();
            expect(quote.amount).toBe(PRICE);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('[PRICE-LOCK] reprice at Pay failed'), 'RazorpayPlugin');
            warn.mockRestore();
        });

        it('R-b: tapping Pay again reuses the Razorpay order; a changed cart gets a new one', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const before = rzp.createCalls;
            const first = await tapPay(c);
            const again = await tapPay(c);
            expect(again.razorpayOrderId).toBe(first.razorpayOrderId);
            expect(rzp.createCalls).toBe(before + 1);
            await c.shop.query(Q.cancel, { id: c.orderId });
            await c.shop.query(Q.addItem, { v: variantId, q: 1 });
            const changed = await tapPay(c);
            expect(changed.razorpayOrderId).not.toBe(first.razorpayOrderId);
            expect(rzp.createCalls).toBe(before + 2);
        });
    });

    describe('settle-time safety net', () => {
        it('R-c: paid exactly the total → placed once, no adjustment line', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            const paymentId = capture(quote.razorpayOrderId, quote.amount);
            expect((await settle(c.orderId)).status).toBe('settled');
            const placed = await order(c.orderId);
            expect(placed.state).toBe('PaymentSettled');
            expect(placed.payments.filter((p: any) => p.transactionId === paymentId)).toHaveLength(1);
            expect(hasAdjustment(placed)).toBe(false);
        });

        it('payment.authorized and payment.captured settling at once → one settlement, one history entry (order 64572)', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            const paymentId = capture(quote.razorpayOrderId, quote.amount);
            // Both jobs load the order while it is still ArrangingPayment, then settle in turn.
            const [capturedJob, authorizedJob] = [await loadForSettle(c.orderId), await loadForSettle(c.orderId)];
            expect((await settle(c.orderId, capturedJob)).status).toBe('settled');
            expect((await settle(c.orderId, authorizedJob)).status).toBe('already');
            const placed = await order(c.orderId);
            expect(placed.history.items.filter((h: any) => h.data?.webhookEvent === 'Settlement')).toHaveLength(1);
            expect(placed.payments.filter((p: any) => p.transactionId === paymentId)).toHaveLength(1);
        });

        it('webhook placed the order before the app returned → the app gets the placed order, not an error (order 64574)', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            const paymentId = capture(quote.razorpayOrderId, quote.amount);
            expect((await settle(c.orderId)).status).toBe('settled');
            const actual = await appPays(c.shop, quote.razorpayOrderId, paymentId);
            expect(actual.__typename).toBe('Order');
            expect(actual.state).toBe('PaymentSettled');
            expect(actual.payments.filter((p: any) => p.transactionId === paymentId)).toEqual([{ state: 'Settled', transactionId: paymentId }]);
        });

        it('after the webhook placed the order, a forged signature or an unrecorded payment still gets the error', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            const paymentId = capture(quote.razorpayOrderId, quote.amount);
            await settle(c.orderId);
            const stranger = new SimpleGraphQLClient(config as any, SHOP_URL);
            expect((await appPays(stranger, quote.razorpayOrderId, paymentId, 'f'.repeat(64))).errorCode).toBe('NO_ACTIVE_ORDER_ERROR');
            expect((await appPays(c.shop, quote.razorpayOrderId, 'pay_never_recorded')).errorCode).toBe('NO_ACTIVE_ORDER_ERROR');
        });

        it('repair: paid the quote, total drifted up during payment → adjustment line, total = paid, placed', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            await drift(c.orderId, 1360000 - PRICE); // total now ₹13,600, like the incident
            capture(quote.razorpayOrderId, quote.amount);
            expect((await settle(c.orderId)).status).toBe('settled');
            const placed = await order(c.orderId);
            expect(placed.state).toBe('PaymentSettled');
            expect(placed.totalWithTax).toBe(PRICE);
            expect(hasAdjustment(placed)).toBe(true);
            expect(notes(placed).some(n => n.startsWith('Checkout amount adjustment'))).toBe(true);
        });

        it('repair also heals an underpaid payment the app already recorded (PR-1 path)', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            await drift(c.orderId, 5000);
            const paymentId = capture(quote.razorpayOrderId, quote.amount);
            const signature = crypto.createHmac('sha256', KEYS.key_secret).update(`${quote.razorpayOrderId}|${paymentId}`).digest('hex');
            await c.shop.query(gql`mutation ($i: PaymentInput!) { addPaymentToOrder(input: $i) { ... on Order { state } ... on ErrorResult { errorCode } } }`,
                { i: { method: 'razorpay-payment', metadata: { razorpayOrderId: quote.razorpayOrderId, razorpayPaymentId: paymentId, razorpaySignature: signature } } });
            expect((await order(c.orderId)).state).toBe('ArrangingPayment'); // underpaid, as in the incident
            await settle(c.orderId);
            const placed = await order(c.orderId);
            expect(placed.state).toBe('PaymentSettled');
            expect(placed.payments.filter((p: any) => p.transactionId === paymentId)).toHaveLength(1);
        });

        it('overpay: price dropped during payment → placed, total untouched, refund note for staff', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            await drift(c.orderId, -20000);
            capture(quote.razorpayOrderId, quote.amount);
            await settle(c.orderId);
            const placed = await order(c.orderId);
            expect(placed.state).toBe('PaymentSettled');
            expect(placed.totalWithTax).toBe(PRICE - 20000);
            expect(hasAdjustment(placed)).toBe(false);
            expect(notes(placed).some(n => n.startsWith('Overpaid') && n.includes('₹200.00'))).toBe(true);
        });

        it.each([
            ['paid an amount that was never quoted', async (c: any, quote: any) => capture(quote.razorpayOrderId, quote.amount - 100)],
            ['the capture is older than 60 minutes', async (c: any, quote: any) => capture(quote.razorpayOrderId, quote.amount, 61)],
        ])('stuck (staff alert, nothing written) when %s', async (_label, pay) => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            await drift(c.orderId, 5000);
            await pay(c, quote);
            const error = vi.spyOn(Logger, 'error');
            expect((await settle(c.orderId)).status).toBe('incomplete');
            expect(error).toHaveBeenCalledWith(expect.stringContaining('[MONEY-STUCK-ALERT]'), 'RazorpayPlugin');
            error.mockRestore();
            const stuck = await order(c.orderId);
            expect(stuck.state).toBe('ArrangingPayment');
            expect(hasAdjustment(stuck)).toBe(false);
            expect(stuck.payments).toHaveLength(0);
        });

        it('stuck when the cart was sent back and changed after the quote (late payment for an old cart)', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            await c.shop.query(Q.cancel, { id: c.orderId });
            await c.shop.query(Q.addItem, { v: variantId, q: 1 }); // now 2 items, ₹2,900
            capture(quote.razorpayOrderId, quote.amount); // late UPI approval of the old ₹1,450 quote
            expect((await settle(c.orderId)).status).toBe('incomplete');
            expect(hasAdjustment(await order(c.orderId))).toBe(false);
        });
    });

    describe('existing behaviour kept (D21)', () => {
        it('R-d: an unpaid, stale ArrangingPayment order is still reverted by reconciliation', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            rzp.orders.get(quote.razorpayOrderId)!.created_at = Math.floor((Date.now() - 10 * 60_000) / 1000);
            const reconciliation = app<RazorpayReconciliationService>(RazorpayReconciliationService);
            const settlement = app<RazorpaySettlementService>(RazorpaySettlementService);
            const ctx = await adminCtx();
            const entity = await app<TransactionalConnection>(TransactionalConnection).getRepository(ctx, Order)
                .findOne({ where: { id: dbId(c.orderId) } as any, relations: ['payments', 'customer', 'channels', 'lines'] });
            await (reconciliation as any).processSingleOrder(ctx, entity, await settlement.getRazorpayClientForCtx(ctx));
            expect((await order(c.orderId)).state).toBe('AddingItems');
        });

        it('R-e: the owner can still generate, read status and cancel', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            await tapPay(c);
            const { getRazorpayOrderStatus } = await c.shop.query(Q.status, { id: c.orderId });
            expect(getRazorpayOrderStatus.status).toBe('attempted');
            const { cancelRazorpayPayment } = await c.shop.query(Q.cancel, { id: c.orderId });
            expect(cancelRazorpayPayment.success).toBe(true);
        });
    });

    describe('double payment (D20)', () => {
        it('a second captured payment on an already-paid order raises [DUPLICATE-CAPTURE] and a refund note', async () => {
            await setPriceSilently(PRICE);
            const c = await cart();
            const quote = await tapPay(c);
            capture(quote.razorpayOrderId, quote.amount);
            await settle(c.orderId);
            const secondPaymentId = capture(quote.razorpayOrderId, quote.amount);
            const body = { event: 'payment.captured', payload: { payment: { entity: { id: secondPaymentId, order_id: quote.razorpayOrderId, amount: quote.amount, notes: {} } } } };
            const raw = JSON.stringify(body);
            const error = vi.spyOn(Logger, 'error');
            await app<RazorpayWebhookService>(RazorpayWebhookService).processWebhook(
                crypto.createHmac('sha256', KEYS.webhook_secret).update(raw).digest('hex'), body, raw);
            expect(error).toHaveBeenCalledWith(expect.stringContaining(`[DUPLICATE-CAPTURE] order=`), 'RazorpayPlugin');
            error.mockRestore();
            expect(notes(await order(c.orderId)).some(n => n.includes(secondPaymentId) && n.startsWith('Duplicate payment'))).toBe(true);
        });
    });
});
