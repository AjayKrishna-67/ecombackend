import { describe, it, expect } from 'vitest';
import { pickOrderSyncChannelId, resolveCurrentChannelPrice } from '../price-sync-plan.util';

/**
 * These specs encode the CORRECT multi-channel behaviour of the price-sync
 * fan-out. They were written red-first to reproduce two shipped bugs:
 *
 *   C1/C2 — a price change was recomputed under the event/default channel, so an
 *   order belonging to a city channel (e.g. Madurai) was rewritten to the master
 *   price. Fix: each order must be recomputed in ITS OWN channel, which means we
 *   must resolve that channel per order. `pickOrderSyncChannelId` is that choice.
 *
 *   W1 — `channelPrice?.price || variant.price` treated a legitimate ₹0 channel
 *   price as falsy and fell back to the master price. `resolveCurrentChannelPrice`
 *   null-checks the row instead of the number.
 */

describe('pickOrderSyncChannelId', () => {
    const DEFAULT = 1;
    it('returns the order\'s own city channel, never the default', () => {
        expect(pickOrderSyncChannelId([1, 4], DEFAULT)).toBe(4);
    });
    it('picks the first non-default channel when an order spans several', () => {
        expect(pickOrderSyncChannelId([1, 4, 5], DEFAULT)).toBe(4);
    });
    it('returns null when the order only lives in the default channel', () => {
        expect(pickOrderSyncChannelId([1], DEFAULT)).toBeNull();
    });
    it('returns null for an order with no channels', () => {
        expect(pickOrderSyncChannelId([], DEFAULT)).toBeNull();
    });
    it('matches channel ids regardless of string/number type (TypeORM raw rows)', () => {
        expect(pickOrderSyncChannelId(['1', '4'], '1')).toBe('4');
        expect(pickOrderSyncChannelId(['1', '4'], 1)).toBe('4');
    });
});

describe('resolveCurrentChannelPrice', () => {
    it('honours a legitimate ₹0 channel price (the W1 bug: || fell back to master)', () => {
        expect(resolveCurrentChannelPrice({ price: 0 }, 50000)).toBe(0);
    });
    it('uses the channel price when present and non-zero', () => {
        expect(resolveCurrentChannelPrice({ price: 4000 }, 50000)).toBe(4000);
    });
    it('falls back to the master price when there is no channel row', () => {
        expect(resolveCurrentChannelPrice(null, 50000)).toBe(50000);
        expect(resolveCurrentChannelPrice(undefined, 50000)).toBe(50000);
    });
});
