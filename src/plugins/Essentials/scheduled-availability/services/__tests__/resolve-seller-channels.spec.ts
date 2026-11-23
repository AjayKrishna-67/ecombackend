import { RequestContext } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { AvailabilityScheduleService } from '../availability-schedule.service';

/**
 * Guards the swap from a frozen channel list to a brand resolved per run.
 *
 * The failure this prevents is silent in both directions: a brand that resolves
 * to nothing sends an empty purchase list, and a brand that wrongly includes the
 * default channel double-counts every order — because the default channel
 * aggregates every other channel's catalogue. Neither looks like an error on the
 * PDF; both look like a plausible day's trading.
 */
function makeService(channels: Array<{ id: number; code: string }>) {
    const connection = {
        getRepository: () => ({ find: async () => channels }),
    };
    return new AvailabilityScheduleService(
        connection as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    );
}

const ctx = {} as RequestContext;

describe('AvailabilityScheduleService.resolveSellerChannelIds', () => {
    it('returns the brand member channels as strings', async () => {
        const service = makeService([
            { id: 4, code: 'Madurai' },
            { id: 6, code: 'Coimbatore' },
        ]);

        expect(await service.resolveSellerChannelIds(ctx, 2)).toEqual(['4', '6']);
    });

    // The default channel aggregates every other channel's catalogue, so
    // including it beside real channels counts each order twice.
    it('excludes the default channel', async () => {
        const service = makeService([
            { id: 1, code: '__default_channel__' },
            { id: 6, code: 'Coimbatore' },
        ]);

        expect(await service.resolveSellerChannelIds(ctx, 2)).toEqual(['6']);
    });

    // A rule with no brand must resolve to nothing rather than to everything:
    // the caller turns an empty list into a recorded skip, whereas "no filter"
    // would silently widen the report to every channel in the system.
    it('returns nothing when the rule names no brand', async () => {
        const service = makeService([{ id: 6, code: 'Coimbatore' }]);

        expect(await service.resolveSellerChannelIds(ctx, null)).toEqual([]);
    });

    it('returns nothing for a brand whose only channel is the default one', async () => {
        const service = makeService([{ id: 1, code: '__default_channel__' }]);

        expect(await service.resolveSellerChannelIds(ctx, 9)).toEqual([]);
    });
});
