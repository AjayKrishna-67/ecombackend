import { RequestContext, ChannelService, ID } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';

import { resolveBrandChannelIds } from './brand-channel-groups';

vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

/** Default channel id matches production `__default_channel__` row (see Workbench). */
const DEFAULT_CHANNEL_ID = 1 as ID;

function mockChannelService(defaultId: ID = DEFAULT_CHANNEL_ID): ChannelService {
    // Source resolves the default channel via findAll({ filter: { code } }), not
    // getDefaultChannel() — the latter reads a bootstrap-only cache that is
    // uninitialized inside an AuthenticationStrategy. Mock findAll accordingly.
    return {
        findAll: vi.fn().mockResolvedValue({ items: [{ id: defaultId }], totalItems: 1 }),
    } as unknown as ChannelService;
}

/**
 * Regression guard: login assigns **default + request channel only**. Stale city
 * rows (e.g. Madurai=4) are removed elsewhere via `syncCustomerChannelsOnLogin`;
 * resolution itself must not list sibling cities.
 */
function mockCtx(channelId: number | string, token: string): RequestContext {
    return {
        channelId,
        channel: { id: channelId, token },
    } as unknown as RequestContext;
}

interface CityChannel {
    city: string;
    channelId: number;
    token: string;
}

const CITY_CHANNELS: CityChannel[] = [
    { city: 'Madurai', channelId: 4, token: 'ind-madurai' },
    { city: 'Salem', channelId: 5, token: 'ind-salem' },
    { city: 'Coimbatore', channelId: 6, token: 'ind-coimbatore' },
];

describe('resolveBrandChannelIds — default + login channel only', () => {
    for (const cityChannel of CITY_CHANNELS) {
        describe(`${cityChannel.city} (channel ${cityChannel.channelId}, ${cityChannel.token})`, () => {
            it('resolves to default channel id and current channel id', async () => {
                const actual = await resolveBrandChannelIds(
                    mockCtx(cityChannel.channelId, cityChannel.token),
                    mockChannelService(),
                );
                expect(actual).toEqual([DEFAULT_CHANNEL_ID, cityChannel.channelId]);
            });

            it('never includes other city channels', async () => {
                const actual = await resolveBrandChannelIds(
                    mockCtx(cityChannel.channelId, cityChannel.token),
                    mockChannelService(),
                );
                const otherCityIds = CITY_CHANNELS.filter(
                    other => other.channelId !== cityChannel.channelId,
                ).map(other => other.channelId);
                for (const otherCityId of otherCityIds) {
                    expect(actual).not.toContain(otherCityId);
                }
            });
        });
    }

    it('ind-test (channel 13): {1, 13}', async () => {
        const actual = await resolveBrandChannelIds(mockCtx(13, 'ind-test'), mockChannelService());
        expect(actual).toEqual([DEFAULT_CHANNEL_ID, 13]);
    });

    it('dedupes when login channel is already the default', async () => {
        const actual = await resolveBrandChannelIds(
            mockCtx(DEFAULT_CHANNEL_ID, '__default_channel__'),
            mockChannelService(),
        );
        expect(actual).toEqual([DEFAULT_CHANNEL_ID]);
    });

    it('cities stay isolated in resolution (targets do not cross-leak)', async () => {
        const madurai = await resolveBrandChannelIds(mockCtx(4, 'ind-madurai'), mockChannelService());
        const salem = await resolveBrandChannelIds(mockCtx(5, 'ind-salem'), mockChannelService());
        const coimbatore = await resolveBrandChannelIds(mockCtx(6, 'ind-coimbatore'), mockChannelService());
        expect(madurai).toEqual([DEFAULT_CHANNEL_ID, 4]);
        expect(salem).toEqual([DEFAULT_CHANNEL_ID, 5]);
        expect(coimbatore).toEqual([DEFAULT_CHANNEL_ID, 6]);
    });
});
