/**
 * Pure helpers for the health-aware price sync — no Vendure/DB deps, so they are
 * cheap to unit-test in isolation.
 */

/**
 * True when a ProductVariantEvent's input could possibly have changed a price.
 *
 * WHY: the plugin subscribes to every `updated` ProductVariantEvent, but that
 * event fires for ANY variant edit -- a weight custom field, a stock location, a
 * facet, an SKU. Without this filter each of those fans out a price re-sync
 * across every active order touching the variant. Measured on 2026-08-06: the
 * last real price change was 2026-07-11, yet 32 sync batches ran on 5-6 August
 * (up to 1096 orders each) purely from variant edits made while migrating weights
 * onto option groups. The backlog reached 1661 pending items, all no-ops.
 *
 * `UpdateProductVariantInput` is a patch, so a key that is absent was not
 * submitted and cannot have changed. Both `price` (default currency) and
 * `prices` (per-currency list) count.
 *
 * DELIBERATELY FAILS OPEN. Anything it cannot positively prove to be
 * price-free -- a missing input, an id-only payload, a non-array, an unexpected
 * shape -- returns true and the sync proceeds. Skipping a real price change
 * means customers check out at stale prices, which is far worse than the wasted
 * work this exists to avoid. Only the provable no-price case is filtered.
 */
export function inputCouldChangePrice(input: unknown): boolean {
    if (!Array.isArray(input) || input.length === 0) {
        return true;
    }
    return input.some(entry => {
        if (entry == null || typeof entry !== 'object') {
            // An ID[] payload (delete, or an internal save) tells us nothing.
            return true;
        }
        return 'price' in entry || 'prices' in entry;
    });
}

/** Exponential backoff for a failed sync attempt: 2,4,8,16,32 min, capped at 32. */
export function backoffMs(attempts: number): number {
    const minutes = Math.min(2 ** Math.max(1, attempts), 32);
    return minutes * 60_000;
}

/**
 * Run `fn` over items with a HARD concurrency cap — never more than `limit` in
 * flight. This is the semaphore that stops the drain exhausting the DB pool.
 * Every item runs exactly once; rejections propagate.
 */
export async function mapWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const size = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;
    const workers = Array.from({ length: size }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            await fn(items[index], index);
        }
    });
    await Promise.all(workers);
}
