/**
 * The order lines worth showing on the order page: those still carrying
 * units. On a placed order Vendure never deletes a line; one the admin
 * cancels in "Modify order" (a coupon's free product taken out with its
 * coupon, say) stays at quantity 0 as the record of the cancellation, for
 * the stock movement, the refund and the order history. Those rows add
 * nothing to the totals, so they are left out of the table only; the
 * order itself, its totals and its history are untouched.
 */
export function visibleOrderLines<T extends { quantity: number }>(lines: readonly T[] | null | undefined): T[] {
    return (lines ?? []).filter(line => line.quantity > 0);
}
