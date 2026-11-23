// src/plugins/Payment/Razorpay/handler/razorpay.handler.ts

import {
    CreatePaymentResult,
    Injector,
    LanguageCode,
    Logger,
    Order,
    PaymentMethodHandler,
    RequestContext,
    SettlePaymentResult,
    TransactionalConnection,
} from '@vendure/core';
import { LockNotSupportedOnGivenDriverError, ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { getRazorpayInstance, isChecksumVerified } from '../utils/razorpay-utils';

/**
 * createPayment runs inside the shop addPaymentToOrder request transaction, and the
 * Razorpay SDK sets no HTTP timeout. Without a bound, a slow Razorpay would hold a
 * pooled DB connection per checkout. Same bound as fetchQrCodeStatus.
 */
const RAZORPAY_FETCH_TIMEOUT_MS = 10_000;

interface RazorpayCheckoutMetadata {
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
}

interface RazorpayKeys {
    key_id: string;
    key_secret: string;
}

/** The fields of a Razorpay payment entity this handler relies on. */
interface RazorpayPayment {
    id: string;
    order_id: string;
    status: string;
    amount: number | string;
}

let connection: TransactionalConnection;

/** Every decline goes through here: logged, and never carries a transactionId (the webhook dedupe would skip a real capture). */
function declinePayment(order: Order, reason: string): CreatePaymentResult {
    Logger.warn(`[PAYMENT-DECLINED] order=${order.code} reason=${reason}`, 'RazorpayPlugin');
    return {
        amount: order.totalWithTax,
        state: 'Declined',
        errorMessage: reason,
        metadata: { errorMessage: reason },
    };
}

/** Checks the app's payload belongs to THIS order and was signed by Razorpay. Returns the decline reason, if any. */
function getBindingError(order: Order, metadata: RazorpayCheckoutMetadata, keys: RazorpayKeys): string | undefined {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = metadata;
    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return 'Missing Razorpay payment details';
    }
    if (razorpayOrderId !== (order.customFields as any)?.razorpayOrderId) {
        return 'Razorpay order does not belong to this order';
    }
    const isValid = isChecksumVerified({ razorpaySignature, razorpayOrderId, razorpayPaymentId, secretKey: keys.key_secret });
    return isValid ? undefined : 'Invalid Razorpay Signature';
}

/**
 * The Android app gives up on addPaymentToOrder after 5 s, so the two slow steps
 * here are logged when together they pass SLOW_STEPS_MS: Razorpay's API, and the
 * wait for the order row lock a webhook settlement may be holding.
 */
const SLOW_STEPS_MS = 2_000;

function logSlowSteps(order: Order, razorpayFetchMs: number, lockWaitMs: number): void {
    if (razorpayFetchMs + lockWaitMs > SLOW_STEPS_MS) {
        Logger.warn(`[ADD-PAYMENT-TIMING] order=${order.code} razorpayFetch=${razorpayFetchMs}ms lockWait=${lockWaitMs}ms`, 'RazorpayPlugin');
    }
}

/** Asks Razorpay for the payment, giving up after RAZORPAY_FETCH_TIMEOUT_MS. */
async function fetchRazorpayPayment(keys: RazorpayKeys, paymentId: string): Promise<RazorpayPayment> {
    const client = getRazorpayInstance({ key_id: keys.key_id, key_secret: keys.key_secret });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Razorpay did not respond')), RAZORPAY_FETCH_TIMEOUT_MS);
    });
    try {
        return (await Promise.race([client.payments.fetch(paymentId), timeout])) as RazorpayPayment;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Locking read: returns the latest committed row even though this transaction's
 * snapshot was taken earlier (MySQL REPEATABLE READ). SQLite (e2e tests) has no
 * row locks and serializes writes itself, so it falls back to a plain read.
 */
async function getOneLocked<T extends ObjectLiteral>(qb: SelectQueryBuilder<T>): Promise<T | null> {
    try {
        return await qb.clone().setLock('pessimistic_write').getOne();
    } catch (e) {
        if (!(e instanceof LockNotSupportedOnGivenDriverError)) {
            throw e;
        }
        return qb.getOne();
    }
}

/**
 * Serializes this app-path payment with webhook settlement, which takes the same
 * order row lock (razorpay-settlement.service.ts). Core addPaymentToOrder takes no
 * lock, so without this both paths could record the same capture and allocate stock
 * twice. True when another writer already recorded it: the order moved on, or its
 * row already carries this Razorpay payment id (see markRecorded).
 *
 * Only the order row is locked, by primary key. A locking read on `payment` by
 * orderId was tried first: with no matching row MySQL takes a gap lock at the end
 * of the index, and two concurrent checkouts then deadlock on their own inserts
 * (7 of 10 concurrent checkouts failed in the MySQL load test).
 */
async function isAlreadyRecorded(ctx: RequestContext, order: Order, razorpayPaymentId: string): Promise<boolean> {
    const lockedOrder = await getOneLocked(
        connection.getRepository(ctx, Order).createQueryBuilder('o').where('o.id = :id', { id: order.id }),
    );
    return (
        !lockedOrder ||
        lockedOrder.state !== order.state ||
        (lockedOrder.customFields as any)?.razorpayPaymentId === razorpayPaymentId
    );
}

/**
 * Stamps the locked order row with the payment being recorded, so a writer
 * waiting on the lock sees it even when the order stays in ArrangingPayment
 * (an underpaid capture). Same transaction as the Payment insert: rolls back with it.
 */
async function markRecorded(ctx: RequestContext, order: Order, razorpayPaymentId: string): Promise<void> {
    await connection.getRepository(ctx, Order).update(order.id, { customFields: { razorpayPaymentId } } as any);
}

/** Mirrors Razorpay's state and amount: captured → Settled, authorized → Authorized, anything else declines. */
function toPaymentResult(order: Order, payment: RazorpayPayment, metadata: RazorpayCheckoutMetadata): CreatePaymentResult {
    const state = payment.status === 'captured' ? 'Settled' : payment.status === 'authorized' ? 'Authorized' : undefined;
    if (!state) {
        return declinePayment(order, `Razorpay payment status is ${payment.status}`);
    }
    const amount = Number(payment.amount);
    if (amount !== order.totalWithTax) {
        Logger.error(
            `[PAYMENT-AMOUNT-MISMATCH] order=${order.code} razorpay=${amount} total=${order.totalWithTax} payment=${payment.id}`,
            'RazorpayPlugin',
        );
    }
    return {
        amount,
        state,
        transactionId: payment.id,
        metadata: { razorpayOrderId: metadata.razorpayOrderId, razorpaySignature: metadata.razorpaySignature },
    };
}

export const razorpayPaymentHandler = new PaymentMethodHandler({
    code: 'razorpay-payment',
    description: [{ languageCode: LanguageCode.en, value: 'Razorpay Payment' }],

    args: {
        config: {
            type: 'string',
            ui: { component: 'razorpay-payment-config' },
            label: [{ languageCode: LanguageCode.en, value: ' ' }],
        }
    },

    init(injector: Injector) {
        connection = injector.get(TransactionalConnection);
    },

    /**
     * App path (shop addPaymentToOrder). Webhooks never come through here: the
     * settlement service writes those payments itself, so a caller-supplied
     * "source" is not trusted and there is no shortcut to Settled.
     */
    createPayment: async (ctx, order, amount, args, metadata): Promise<CreatePaymentResult> => {
        try {
            const keys: RazorpayKeys = typeof args.config === 'string' ? JSON.parse(args.config) : args.config;
            const checkout = metadata as RazorpayCheckoutMetadata;
            const bindingError = getBindingError(order, checkout, keys);
            if (bindingError) {
                return declinePayment(order, bindingError);
            }
            const fetchStartedAt = Date.now();
            let payment: RazorpayPayment;
            try {
                payment = await fetchRazorpayPayment(keys, checkout.razorpayPaymentId as string);
            } catch (e: any) {
                return declinePayment(order, e?.error?.description ?? e?.message ?? 'Could not verify payment with Razorpay');
            }
            if (payment.order_id !== checkout.razorpayOrderId) {
                return declinePayment(order, 'Razorpay payment belongs to a different Razorpay order');
            }
            const lockStartedAt = Date.now();
            const isRecorded = await isAlreadyRecorded(ctx, order, payment.id);
            logSlowSteps(order, lockStartedAt - fetchStartedAt, Date.now() - lockStartedAt);
            if (isRecorded) {
                return declinePayment(order, 'Payment already recorded');
            }
            const result = toPaymentResult(order, payment, checkout);
            if (result.state !== 'Declined') {
                await markRecorded(ctx, order, payment.id);
            }
            return result;
        } catch (err: any) {
            return declinePayment(order, err?.message ?? 'Razorpay payment could not be processed');
        }
    },

    settlePayment: async (ctx, order, payment, args): Promise<SettlePaymentResult> => {
        return { success: true };
    },
});
