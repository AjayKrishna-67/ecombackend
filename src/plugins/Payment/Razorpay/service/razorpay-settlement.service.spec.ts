import { Logger } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RazorpaySettlementService } from './razorpay-settlement.service';

const NOW_MS = Date.parse('2026-10-21T12:00:00Z');
const MINUTE_S = 60;
const nowSeconds = NOW_MS / 1000;

/** Razorpay client stub: the order's status plus its list of payment attempts. */
function mockRazorpayClient(orderStatus: string, attempts: Array<{ status: string; created_at: number }>) {
    return {
        orders: {
            fetch: vi.fn(async () => ({ id: 'order_A', status: orderStatus })),
            fetchPayments: vi.fn(async () => ({ items: attempts })),
        },
    };
}

function buildService(): RazorpaySettlementService {
    return new RazorpaySettlementService({} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('RazorpaySettlementService.getPaymentActivity', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("is 'paid' when the Razorpay order is paid", async () => {
        const actual = await buildService().getPaymentActivity('order_A', mockRazorpayClient('paid', []));
        expect(actual).toBe('paid');
    });

    it.each(['captured', 'authorized'])("is 'paid' when an attempt is %s", async status => {
        const client = mockRazorpayClient('attempted', [{ status, created_at: nowSeconds - 30 * MINUTE_S }]);
        expect(await buildService().getPaymentActivity('order_A', client)).toBe('paid');
    });

    it("is 'in-progress' while an attempt awaits UPI/bank approval (created 2 min ago)", async () => {
        const client = mockRazorpayClient('attempted', [
            { status: 'failed', created_at: nowSeconds - 5 * MINUTE_S },
            { status: 'created', created_at: nowSeconds - 2 * MINUTE_S },
        ]);
        expect(await buildService().getPaymentActivity('order_A', client)).toBe('in-progress');
    });

    it("is 'unpaid' once a created attempt is older than the 15-minute window (abandoned)", async () => {
        const client = mockRazorpayClient('attempted', [{ status: 'created', created_at: nowSeconds - 16 * MINUTE_S }]);
        expect(await buildService().getPaymentActivity('order_A', client)).toBe('unpaid');
    });

    it("is 'unpaid' when the checkout was only opened (no attempt) or every attempt failed", async () => {
        expect(await buildService().getPaymentActivity('order_A', mockRazorpayClient('created', []))).toBe('unpaid');
        const failedOnly = mockRazorpayClient('attempted', [{ status: 'failed', created_at: nowSeconds - MINUTE_S }]);
        expect(await buildService().getPaymentActivity('order_A', failedOnly)).toBe('unpaid');
    });

    it("is 'unknown' (never revert) when Razorpay cannot be asked", async () => {
        const client = {
            orders: {
                fetch: vi.fn(async () => {
                    throw { statusCode: 500, error: { description: 'Gateway timeout' } };
                }),
                fetchPayments: vi.fn(),
            },
        };
        expect(await buildService().getPaymentActivity('order_A', client)).toBe('unknown');
    });
});
