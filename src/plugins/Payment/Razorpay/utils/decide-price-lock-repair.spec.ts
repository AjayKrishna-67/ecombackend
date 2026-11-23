import { describe, expect, it } from 'vitest';
import { decidePriceLockRepair, PRICE_LOCK_REPAIR_WINDOW_MS, PriceLockRepairInput } from './decide-price-lock-repair';

const NOW = Date.parse('2026-10-22T08:40:00Z');

/** The real-world case that started this: quoted and paid ₹1,450, total jumped to ₹13,600. */
function underpaid(overrides: Partial<PriceLockRepairInput> = {}): PriceLockRepairInput {
    return {
        capturedAmount: 145000,
        razorpayOrderAmount: 145000,
        totalWithTax: 1360000,
        capturedAtMs: NOW - 2 * 60 * 1000,
        nowMs: NOW,
        stayedInArrangingPayment: true,
        ...overrides,
    };
}

describe('decidePriceLockRepair', () => {
    it("is 'ok' when the customer paid exactly the total (normal checkout)", () => {
        expect(decidePriceLockRepair(underpaid({ totalWithTax: 145000 }))).toEqual({ action: 'ok' });
    });

    it("is 'overpay' with the refund amount when the price dropped during payment, never touching the total", () => {
        expect(decidePriceLockRepair(underpaid({ totalWithTax: 120000 }))).toEqual({ action: 'overpay', refundAmount: 25000 });
    });

    it("is 'overpay' even when the quote facts are unknown (settling cannot hurt; staff refund)", () => {
        const actual = decidePriceLockRepair(underpaid({ totalWithTax: 120000, razorpayOrderAmount: null, capturedAtMs: null, stayedInArrangingPayment: null }));
        expect(actual.action).toBe('overpay');
    });

    it("is 'repair' with a negative adjustment for a quoted, recent, never-reverted underpay (no size cap)", () => {
        expect(decidePriceLockRepair(underpaid())).toEqual({ action: 'repair', adjustment: 145000 - 1360000 });
    });

    it('repairs right up to the 60-minute window', () => {
        const actual = decidePriceLockRepair(underpaid({ capturedAtMs: NOW - PRICE_LOCK_REPAIR_WINDOW_MS }));
        expect(actual.action).toBe('repair');
    });

    it.each([
        ['the Razorpay order amount is unknown', { razorpayOrderAmount: null }, 'unknown-input'],
        ['the capture time is unknown', { capturedAtMs: null }, 'unknown-input'],
        ['the revert history is unknown', { stayedInArrangingPayment: null }, 'unknown-input'],
        ['the customer paid something other than the quote', { razorpayOrderAmount: 150000 }, 'amount-not-quoted'],
        ['the cart was sent back to AddingItems after the quote', { stayedInArrangingPayment: false }, 'reverted-after-quote'],
        ['the capture is older than 60 minutes (old backlog)', { capturedAtMs: NOW - PRICE_LOCK_REPAIR_WINDOW_MS - 1 }, 'captured-too-long-ago'],
        ['the capture time is in the future', { capturedAtMs: NOW + 1000 }, 'captured-too-long-ago'],
    ])("is 'stuck' (staff) when %s", (_label, overrides, reason) => {
        expect(decidePriceLockRepair(underpaid(overrides as Partial<PriceLockRepairInput>))).toEqual({ action: 'stuck', reason });
    });
});
