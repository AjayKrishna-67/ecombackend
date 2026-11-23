import { ID } from '@vendure/core';

/**
 * Pure decision helpers for the price-sync fan-out. Kept side-effect free so the
 * multi-channel correctness rules can be unit-tested without a database (this
 * repo has no integration harness — see price-sync-plan.spec.ts).
 */

/**
 * Pick the channel an order must be recomputed in. A Vendure order belongs to
 * the default (master) channel PLUS its own city channel; its line prices
 * reflect the city channel. Recomputing under the default channel reads the
 * master price and corrupts the order (bugs C1/C2). So we resolve the order's
 * own non-default channel and recompute there. Ids are compared as strings
 * because TypeORM raw rows may return numeric ids as strings.
 */
export function pickOrderSyncChannelId(
    orderChannelIds: ReadonlyArray<ID>,
    defaultChannelId: ID,
): ID | null {
    const defaultKey = `${defaultChannelId}`;
    const own = orderChannelIds.find(id => `${id}` !== defaultKey);
    return own ?? null;
}

/**
 * Resolve the current price for a variant in a channel. A channel price row of
 * `0` is a legitimate free price — null-check the ROW, never the number (bug W1:
 * `channelPrice?.price || fallback` fell back to the master price on ₹0).
 */
export function resolveCurrentChannelPrice(
    channelPrice: { price: number } | null | undefined,
    fallbackPrice: number,
): number {
    return channelPrice ? channelPrice.price : fallbackPrice;
}
