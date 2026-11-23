import * as crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { RazorpayAddPaymentResolver } from './razorpay-add-payment.resolver';

const KEY_SECRET = 'unit_key_secret';
const ACCOUNT_USER_ID = 7;
const RAZORPAY_ORDER_ID = 'order_unit_1';
const RAZORPAY_PAYMENT_ID = 'pay_unit_1';

function sign(paymentId = RAZORPAY_PAYMENT_ID): string {
    return crypto.createHmac('sha256', KEY_SECRET).update(`${RAZORPAY_ORDER_ID}|${paymentId}`).digest('hex');
}

function buildInput(metadata: Record<string, unknown> = {}) {
    return {
        method: 'razorpay-payment',
        metadata: { razorpayOrderId: RAZORPAY_ORDER_ID, razorpayPaymentId: RAZORPAY_PAYMENT_ID, razorpaySignature: sign(), ...metadata },
    };
}

/** The order the webhook already placed: one Settled payment for RAZORPAY_PAYMENT_ID. */
function buildPlacedOrder({ hasAccount = true, channelId = 1 } = {}): any {
    return {
        id: 42,
        code: 'PLACED42',
        state: 'PaymentSettled',
        channels: [{ id: channelId }],
        customer: { user: hasAccount ? { id: ACCOUNT_USER_ID } : null },
        payments: [{ transactionId: RAZORPAY_PAYMENT_ID, state: 'Settled' }],
    };
}

/**
 * Core finds no active order (the webhook placed it), so the fallback decides:
 * it returns the placed order (`orderService.findOne`) or core's NoActiveOrderError.
 */
function buildResolver(placedOrder: any = buildPlacedOrder()) {
    const orderService: any = { findOne: vi.fn(async () => ({ id: 42, state: 'PaymentSettled' })), addPaymentToOrder: vi.fn() };
    const activeOrderService: any = { getActiveOrder: vi.fn(async () => undefined) };
    const connection: any = {
        withTransaction: (ctx: any, work: (txCtx: any) => unknown) => work(ctx),
        getRepository: () => ({ findOne: async () => placedOrder }),
    };
    const settlementService: any = { getRazorpayConfigForCtx: async () => ({ key_id: 'rzp_test_unit', key_secret: KEY_SECRET }) };
    const resolver = new RazorpayAddPaymentResolver(orderService, activeOrderService, {} as any, {} as any, connection, settlementService);
    return { resolver, orderService };
}

const ownerCtx: any = { channelId: 1, authorizedAsOwnerOnly: true, activeUserId: String(ACCOUNT_USER_ID) };
const otherCustomerCtx: any = { channelId: 1, authorizedAsOwnerOnly: true, activeUserId: '99' };
const anonymousCtx: any = { channelId: 1, authorizedAsOwnerOnly: true };

describe('RazorpayAddPaymentResolver: app call after the webhook placed the order', () => {
    it('returns the placed order to the logged-in owner who presents the payment signature', async () => {
        const { resolver } = buildResolver();
        const actual: any = await resolver.addPaymentToOrder(ownerCtx, { input: buildInput() });
        expect(actual).toEqual({ id: 42, state: 'PaymentSettled' });
    });

    it('returns a guest order to a caller with the payment signature (the session no longer holds it)', async () => {
        const { resolver } = buildResolver(buildPlacedOrder({ hasAccount: false }));
        const actual: any = await resolver.addPaymentToOrder(anonymousCtx, { input: buildInput() });
        expect(actual).toEqual({ id: 42, state: 'PaymentSettled' });
    });

    it.each([
        ['another logged-in customer', otherCustomerCtx, buildInput(), buildPlacedOrder()],
        ['an anonymous caller, for an account order', anonymousCtx, buildInput(), buildPlacedOrder()],
        ['a forged signature', ownerCtx, buildInput({ razorpaySignature: 'f'.repeat(64) }), buildPlacedOrder()],
        ['a payment the order does not hold', ownerCtx, buildInput({ razorpayPaymentId: 'pay_other', razorpaySignature: sign('pay_other') }), buildPlacedOrder()],
        ['an order in another channel', ownerCtx, buildInput(), buildPlacedOrder({ channelId: 2 })],
        ['a non-Razorpay payment method', ownerCtx, { ...buildInput(), method: 'cash' }, buildPlacedOrder()],
    ])('keeps core\'s error for %s; the order is not returned', async (_label, ctx, input, placedOrder) => {
        const { resolver, orderService } = buildResolver(placedOrder);
        const actual: any = await resolver.addPaymentToOrder(ctx, { input } as any);
        expect(actual.errorCode).toBe('NO_ACTIVE_ORDER_ERROR');
        expect(orderService.findOne).not.toHaveBeenCalled();
    });
});
