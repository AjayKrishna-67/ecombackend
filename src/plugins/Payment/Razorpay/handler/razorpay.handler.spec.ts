import * as crypto from 'crypto';
import { Logger, Order } from '@vendure/core';
import { LockNotSupportedOnGivenDriverError } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the Razorpay HTTP client is faked; the checksum helper stays real so the
// tests sign payloads exactly like Razorpay checkout does.
const mockRazorpay = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../utils/razorpay-utils', async importOriginal => {
    const actual = await importOriginal<typeof import('../utils/razorpay-utils')>();
    return { ...actual, getRazorpayInstance: () => ({ payments: { fetch: mockRazorpay.fetch } }) };
});

import { razorpayPaymentHandler } from './razorpay.handler';

const KEYS = { key_id: 'rzp_test_key', key_secret: 'test_key_secret' };
const inputArgs = [{ name: 'config', value: JSON.stringify(KEYS) }];
const mockCtx: any = { channelId: 1 };

interface LockedRows {
    /** The order row as the locking read returns it (latest committed). */
    order?: Record<string, unknown> | null;
    isLockUnsupported?: boolean;
}

/**
 * Stub for the handler's one locking read (the order row, by id) and its marker
 * update. A clone carries its own lock flag, like TypeORM; with
 * `isLockUnsupported` a locked getOne throws the driver error SQLite raises, so
 * the plain-read fallback is exercised. Any other entity fails the test: the
 * handler must not range-lock the payment table (that deadlocked on MySQL).
 */
function mockConnection(rows: LockedRows) {
    const lockModes: string[] = [];
    const orderUpdates: Array<{ id: unknown; values: unknown }> = [];
    function queryBuilder(result: unknown, isLocked = false): any {
        const qb: any = {
            where: () => qb,
            andWhere: () => qb,
            clone: () => queryBuilder(result, isLocked),
            setLock: (mode: string) => {
                lockModes.push(mode);
                return queryBuilder(result, true);
            },
            getOne: async () => {
                if (isLocked && rows.isLockUnsupported) {
                    throw new LockNotSupportedOnGivenDriverError();
                }
                return result;
            },
        };
        return qb;
    }
    const connection = {
        getRepository: (_ctx: unknown, entity: unknown) => {
            if (entity !== Order) {
                throw new Error(`Unexpected repository ${(entity as any)?.name}: only the order row may be locked`);
            }
            return {
                createQueryBuilder: () => queryBuilder(rows.order),
                update: async (id: unknown, values: unknown) => {
                    orderUpdates.push({ id, values });
                },
            };
        },
    };
    return { connection, lockModes, orderUpdates };
}

function buildOrder(overrides: Record<string, unknown> = {}): any {
    return {
        id: 42,
        code: 'ORDER42',
        state: 'ArrangingPayment',
        totalWithTax: 25000,
        customFields: { razorpayOrderId: 'order_A' },
        ...overrides,
    };
}

function signCheckout(razorpayOrderId: string, razorpayPaymentId: string, secret = KEYS.key_secret): string {
    return crypto.createHmac('sha256', secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
}

function validMetadata(): Record<string, string> {
    return { razorpayOrderId: 'order_A', razorpayPaymentId: 'pay_A', razorpaySignature: signCheckout('order_A', 'pay_A') };
}

function razorpayPayment(overrides: Record<string, unknown> = {}) {
    return { id: 'pay_A', order_id: 'order_A', status: 'captured', amount: 25000, ...overrides };
}

async function runCreatePayment(order: any, metadata: Record<string, unknown>) {
    return razorpayPaymentHandler.createPayment(mockCtx, order, order.totalWithTax, inputArgs, metadata, {} as any);
}

async function initHandler(rows: LockedRows = { order: { state: 'ArrangingPayment', customFields: {} } }) {
    const mocks = mockConnection(rows);
    await razorpayPaymentHandler.init({ get: () => mocks.connection } as any);
    return mocks;
}

describe('razorpayPaymentHandler.createPayment', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockRazorpay.fetch.mockReset();
        warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('declines without asking Razorpay', () => {
        it('a forged webhook-source payment (the old free-order shortcut)', async () => {
            await initHandler();
            const actual = await runCreatePayment(buildOrder(), { source: 'webhook', paymentId: 'pay_X', webhookData: {} });
            expect(actual.state).toBe('Declined');
            expect(actual.transactionId).toBeUndefined();
            expect(mockRazorpay.fetch).not.toHaveBeenCalled();
        });

        it('a payload for a different Razorpay order (replayed triple)', async () => {
            await initHandler();
            const metadata = { razorpayOrderId: 'order_OTHER', razorpayPaymentId: 'pay_A', razorpaySignature: signCheckout('order_OTHER', 'pay_A') };
            const actual = await runCreatePayment(buildOrder(), metadata);
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('Razorpay order does not belong to this order');
            expect(mockRazorpay.fetch).not.toHaveBeenCalled();
        });

        it('a signature made with the wrong secret', async () => {
            await initHandler();
            const metadata = { ...validMetadata(), razorpaySignature: signCheckout('order_A', 'pay_A', 'not-the-secret') };
            const actual = await runCreatePayment(buildOrder(), metadata);
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('Invalid Razorpay Signature');
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[PAYMENT-DECLINED] order=ORDER42'), 'RazorpayPlugin');
        });
    });

    describe('declines when Razorpay cannot confirm the payment', () => {
        it('surfaces the Razorpay API error description (SDK errors have no .message)', async () => {
            await initHandler();
            mockRazorpay.fetch.mockRejectedValue({ statusCode: 400, error: { description: 'The id provided does not exist' } });
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('The id provided does not exist');
            expect(actual.transactionId).toBeUndefined();
        });

        it('gives up after 10 seconds when Razorpay never answers', async () => {
            vi.useFakeTimers();
            await initHandler();
            mockRazorpay.fetch.mockReturnValue(new Promise(() => undefined));
            const pending = runCreatePayment(buildOrder(), validMetadata());
            await vi.advanceTimersByTimeAsync(10_000);
            const actual = await pending;
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('Razorpay did not respond');
        });

        it('rejects a Razorpay payment that belongs to another Razorpay order', async () => {
            await initHandler();
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment({ order_id: 'order_OTHER' }));
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual.state).toBe('Declined');
            expect(actual.transactionId).toBeUndefined();
        });

        it('declines a payment Razorpay reports as failed', async () => {
            await initHandler();
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment({ status: 'failed' }));
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('Razorpay payment status is failed');
        });
    });

    describe('mirrors a verified Razorpay payment', () => {
        it('captured → Settled for the Razorpay amount, under the order row lock', async () => {
            const { lockModes, orderUpdates } = await initHandler();
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment({ amount: '25000' }));
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual).toMatchObject({ state: 'Settled', amount: 25000, transactionId: 'pay_A' });
            // One primary-key lock on the order row, then the order row is stamped with the payment id.
            expect(lockModes).toEqual(['pessimistic_write']);
            expect(orderUpdates).toEqual([{ id: 42, values: { customFields: { razorpayPaymentId: 'pay_A' } } }]);
            expect(errorSpy).not.toHaveBeenCalled();
        });

        it('authorized → Authorized', async () => {
            await initHandler();
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment({ status: 'authorized' }));
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual).toMatchObject({ state: 'Authorized', transactionId: 'pay_A' });
        });

        it('records what Razorpay captured, not the order total, and flags the mismatch', async () => {
            await initHandler();
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment({ amount: 24000 }));
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual).toMatchObject({ state: 'Settled', amount: 24000 });
            expect(errorSpy).toHaveBeenCalledWith(
                '[PAYMENT-AMOUNT-MISMATCH] order=ORDER42 razorpay=24000 total=25000 payment=pay_A',
                'RazorpayPlugin',
            );
        });

        it('falls back to a plain read where row locks are unsupported (SQLite tests)', async () => {
            await initHandler({ order: { state: 'ArrangingPayment', customFields: {} }, isLockUnsupported: true });
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment());
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual.state).toBe('Settled');
        });
    });

    describe('backs off when the webhook already recorded the payment', () => {
        it('the order moved on while this request waited for the lock', async () => {
            await initHandler({ order: { state: 'PaymentSettled', customFields: { razorpayPaymentId: 'pay_A' } } });
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment());
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('Payment already recorded');
            expect(actual.transactionId).toBeUndefined();
        });

        it('the same Razorpay payment is already on the order (e.g. an earlier underpaid record)', async () => {
            const { orderUpdates } = await initHandler({ order: { state: 'ArrangingPayment', customFields: { razorpayPaymentId: 'pay_A' } } });
            mockRazorpay.fetch.mockResolvedValue(razorpayPayment());
            const actual = await runCreatePayment(buildOrder(), validMetadata());
            expect(actual.state).toBe('Declined');
            expect(actual.errorMessage).toBe('Payment already recorded');
            expect(orderUpdates).toEqual([]);
        });
    });
});
