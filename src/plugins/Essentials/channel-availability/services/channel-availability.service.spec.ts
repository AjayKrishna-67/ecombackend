import { describe, it, expect } from 'vitest';
import { Channel } from '@vendure/core';
import { ChannelAvailabilityService } from './channel-availability.service';

/**
 * Service-level integration test for resolveSellerAvailability — the pincode →
 * per-brand isAvailable logic that powers the greyed-out switcher. The repo has
 * no real-server e2e harness, so we mock TransactionalConnection + ChannelService
 * (the same style as invoice-number.service.spec) and drive the real method.
 */

interface FakeChannel {
    id: number;
    code: string;
    customFields: { type: string; enabled: boolean };
    seller: { id: number };
}

interface FakePostalRow {
    channelId: number;
    code: string;
    isAnywhere: boolean;
}

function makeService(channels: FakeChannel[], postalRows: FakePostalRow[]): ChannelAvailabilityService {
    const channelRepo = {
        // resolveSellerByChannel loads channels with their seller relation
        find: async () => channels,
    };
    const postalQb = {
        innerJoin() { return this; },
        addSelect() { return this; },
        where() { return this; },
        async getRawAndEntities() {
            return {
                entities: postalRows.map(r => ({ code: r.code, isAnywhere: r.isAnywhere })),
                raw: postalRows.map(r => ({ channelId: r.channelId })),
            };
        },
    };
    const postalRepo = { createQueryBuilder: () => postalQb };
    const connection = {
        getRepository: (_ctx: unknown, entity: unknown) =>
            entity === Channel ? channelRepo : postalRepo,
    };
    const channelService = { findAll: async () => ({ items: channels }) };
    return new ChannelAvailabilityService(
        connection as any,
        channelService as any,
        {} as any, // customerService — unused here
        {} as any, // cacheService — unused here
        {} as any, // brandStorefrontService — unused here
        {} as any, // brandSwitcherService — unused here
    );
}

const KAAIKANI_MADURAI: FakeChannel = {
    id: 4, code: 'Madurai', customFields: { type: 'CITY', enabled: true }, seller: { id: 2 },
};
const SIP_COIMBATORE: FakeChannel = {
    id: 13, code: 'Sip Coimbatore', customFields: { type: 'BRAND', enabled: true }, seller: { id: 5 },
};
const SM_NATIONAL_ANYWHERE: FakeChannel = {
    id: 8, code: 'South Mithai', customFields: { type: 'India', enabled: true }, seller: { id: 3 },
};

describe('ChannelAvailabilityService.resolveSellerAvailability', () => {
    it('marks a brand available only when one of its channels serves the pincode', async () => {
        const svc = makeService(
            [KAAIKANI_MADURAI, SIP_COIMBATORE],
            [
                { channelId: 4, code: '625001', isAnywhere: false },
                { channelId: 13, code: '641001', isAnywhere: false },
            ],
        );
        const result = await svc.resolveSellerAvailability({} as any, ['2', '5'], '625001');
        expect(result.get('2')).toBe(true); // Madurai serves 625001
        expect(result.get('5')).toBe(false); // Sip (Coimbatore 641001) does not
    });

    it('flips per pincode — Coimbatore pincode makes Sip available, Kaaikani not', async () => {
        const svc = makeService(
            [KAAIKANI_MADURAI, SIP_COIMBATORE],
            [
                { channelId: 4, code: '625001', isAnywhere: false },
                { channelId: 13, code: '641001', isAnywhere: false },
            ],
        );
        const result = await svc.resolveSellerAvailability({} as any, ['2', '5'], '641001');
        expect(result.get('2')).toBe(false);
        expect(result.get('5')).toBe(true);
    });

    it('isAnywhere channel is available for any pincode', async () => {
        const svc = makeService(
            [SM_NATIONAL_ANYWHERE],
            [{ channelId: 8, code: 'ANYWHERE', isAnywhere: true }],
        );
        const result = await svc.resolveSellerAvailability({} as any, ['3'], '999999');
        expect(result.get('3')).toBe(true);
    });

    it('returns an empty map when no seller ids are requested', async () => {
        const svc = makeService([], []);
        const result = await svc.resolveSellerAvailability({} as any, [], '625001');
        expect(result.size).toBe(0);
    });
});
