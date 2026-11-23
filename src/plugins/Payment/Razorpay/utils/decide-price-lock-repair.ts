/** How long after capture an underpaid order may still be repaired automatically (D17). */
export const PRICE_LOCK_REPAIR_WINDOW_MS = 60 * 60 * 1000;

export interface PriceLockRepairInput {
    /** What Razorpay captured for this payment, in paise. */
    readonly capturedAmount: number;
    /** What the Razorpay order was created for (the quote the customer saw); null = could not be fetched. */
    readonly razorpayOrderAmount: number | null;
    /** The Vendure order total right now. */
    readonly totalWithTax: number;
    /** When Razorpay created the payment (ms epoch); null = unknown. */
    readonly capturedAtMs: number | null;
    readonly nowMs: number;
    /** No ArrangingPayment → AddingItems revert since the Razorpay order was created; null = unknown. */
    readonly stayedInArrangingPayment: boolean | null;
}

export type PriceLockStuckReason = 'unknown-input' | 'amount-not-quoted' | 'reverted-after-quote' | 'captured-too-long-ago';

export type PriceLockRepairDecision =
    | { readonly action: 'ok' }
    | { readonly action: 'overpay'; readonly refundAmount: number }
    | { readonly action: 'repair'; readonly adjustment: number }
    | { readonly action: 'stuck'; readonly reason: PriceLockStuckReason };

/**
 * Decides what settlement does when the captured amount and the order total
 * differ (D12, D13, D16, D17):
 * - equal → settle as normal ('ok');
 * - customer paid more → settle, and staff refunds the difference ('overpay'),
 *   never inflating the order total;
 * - customer paid less → honor the quote ('repair': add an adjustment so the
 *   total equals what was paid) only when it is provably the quoted amount: it
 *   equals the Razorpay order amount, the cart was never reverted after the
 *   quote, and the capture is recent (keeps the old backlog with staff). Any
 *   unknown input fails closed ('stuck' → staff alert). No size cap (D12).
 */
export function decidePriceLockRepair(input: PriceLockRepairInput): PriceLockRepairDecision {
    const { capturedAmount, razorpayOrderAmount, totalWithTax, capturedAtMs, nowMs, stayedInArrangingPayment } = input;
    if (capturedAmount === totalWithTax) {
        return { action: 'ok' };
    }
    if (capturedAmount > totalWithTax) {
        return { action: 'overpay', refundAmount: capturedAmount - totalWithTax };
    }
    if (razorpayOrderAmount == null || capturedAtMs == null || stayedInArrangingPayment == null) {
        return { action: 'stuck', reason: 'unknown-input' };
    }
    if (capturedAmount !== razorpayOrderAmount) {
        return { action: 'stuck', reason: 'amount-not-quoted' };
    }
    if (!stayedInArrangingPayment) {
        return { action: 'stuck', reason: 'reverted-after-quote' };
    }
    const ageMs = nowMs - capturedAtMs;
    if (ageMs < 0 || ageMs > PRICE_LOCK_REPAIR_WINDOW_MS) {
        return { action: 'stuck', reason: 'captured-too-long-ago' };
    }
    return { action: 'repair', adjustment: capturedAmount - totalWithTax };
}
