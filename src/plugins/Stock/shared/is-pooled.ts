import { isCustomFieldTrue } from './custom-field-boolean';

/**
 * The single answer to "does this product's stock live in the shared pool?".
 *
 * Both halves are required, and the reason is a deadlock that reached
 * customers: the allocation strategy asked ONLY the `productStockEnabled`
 * toggle, while cart validation and the checkout guard asked ONLY whether a
 * `ProductStockLevel` row existed. Turning the toggle off therefore moved the
 * selling side onto per-variant stock while leaving the buying side on a pool
 * that still read 0 — every such product could be added to a cart and could
 * never be checked out. The only escape was deleting the pool row.
 *
 * So: a row without the toggle is dormant history, not a pool. The toggle
 * without a row is an intention with nothing behind it. Only both together
 * mean the pool governs this product.
 *
 * Rows are deliberately KEPT when the toggle goes off, so a merchant can flip
 * back without re-entering stock. The cost is that `stockAllocated` on a
 * dormant row goes stale — nothing decrements it while the pool is inert — so
 * re-enabling must reconcile before trusting it. See
 * ProductStockService.reconcileAllocated.
 *
 * Framework-free (no Vendure / NestJS / React imports) so the dashboard bundle
 * can import it — same rule as ./measurement.ts and ./pool-measure.ts.
 */
export function isPooled(productCustomFields: unknown, hasPoolRow: boolean): boolean {
    return hasPoolRow && isPoolToggleOn(productCustomFields);
}

/**
 * Reads the merchant's `productStockEnabled` intention alone.
 *
 * For the one caller that has already established a pool row by other means —
 * the allocation strategy, which looks the row up separately and returns empty
 * when it finds none. Everything else wants `isPooled`, so that the row and the
 * toggle are never weighed independently again.
 */
export function isPoolToggleOn(productCustomFields: unknown): boolean {
    const flag = (productCustomFields as { productStockEnabled?: unknown } | null | undefined)
        ?.productStockEnabled;
    return isCustomFieldTrue(flag);
}
