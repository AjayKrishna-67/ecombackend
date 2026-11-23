/**
 * What a bill line costs after the coupon's item-level discounts (a free
 * product, a percentage off a product, buy X get Y) — the same figures the
 * customer's own invoice (app / website) prints per line.
 *
 * Order-level coupon discounts are NOT in here: they stay a separate line in
 * the bill totals, as on the customer's invoice.
 */
export function billLineAmounts(line: { linePriceWithTax: number; discountedLinePriceWithTax: number }): {
    /** Line total after item-level coupon discounts, incl. tax (paise). */
    discountedTotal: number;
    /** A coupon gift product: it has a price but the customer pays nothing for it. */
    isFree: boolean;
} {
    const full = Math.max(0, Math.round(Number(line.linePriceWithTax) || 0));
    const discounted = Math.min(full, Math.max(0, Math.round(Number(line.discountedLinePriceWithTax) || 0)));
    return { discountedTotal: discounted, isFree: full > 0 && discounted === 0 };
}
