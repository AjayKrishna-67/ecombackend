import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

import { DeliveryRouteService } from './delivery-route.service';

// Documented Google example — decodes to (38.5,-120.2) (40.7,-120.95) (43.252,-126.453)
const POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const ON_PATH = { lat: 38.5, lng: -120.2 };
const OFF_PATH = { lat: 39.5, lng: -119.0 }; // ~150 km from the line
const DEST = { lat: 43.252, lng: -126.453 };

function googleOk(polyline = POLYLINE, distance = 1234, duration = '600s') {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            routes: [{ distanceMeters: distance, duration, polyline: { encodedPolyline: polyline } }],
        }),
        text: async () => '',
    };
}

describe('DeliveryRouteService', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let gateway: { hasOrderWatchers: ReturnType<typeof vi.fn>; emitDeliveryRoute: ReturnType<typeof vi.fn> };
    let service: DeliveryRouteService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        vi.stubEnv('GOOGLE_MAPS_SERVER_KEY', 'test-key');
        fetchMock = vi.fn(async () => googleOk());
        vi.stubGlobal('fetch', fetchMock);
        gateway = { hasOrderWatchers: vi.fn(() => true), emitDeliveryRoute: vi.fn() };
        service = new DeliveryRouteService(gateway as any);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    // ── routeForOrder (query path) ──

    it('computes and caches the route: a second on-path call makes no new request', async () => {
        const first = await service.routeForOrder('42', ON_PATH, DEST);
        const second = await service.routeForOrder('42', ON_PATH, DEST);

        expect(first).toEqual({ encodedPolyline: POLYLINE, distanceMeters: 1234, durationSeconds: 600 });
        expect(second).toEqual(first);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns null without calling Google when no key is configured', async () => {
        vi.stubEnv('GOOGLE_MAPS_SERVER_KEY', '');
        vi.stubEnv('GOOGLE_MAPS_API_KEY', '');

        expect(await service.routeForOrder('42', ON_PATH, DEST)).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null (and does not cache a failure) when Google errors', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}), text: async () => 'boom' });

        expect(await service.routeForOrder('42', ON_PATH, DEST)).toBeNull();
    });

    // ── maybeRefreshRoute (driver-fix path) ──

    it('does nothing when nobody is watching the order', async () => {
        gateway.hasOrderWatchers.mockReturnValue(false);

        await service.maybeRefreshRoute('42', OFF_PATH, DEST);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(gateway.emitDeliveryRoute).not.toHaveBeenCalled();
    });

    it('computes and pushes the route when watchers exist and none is cached', async () => {
        await service.maybeRefreshRoute('42', ON_PATH, DEST);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(gateway.emitDeliveryRoute).toHaveBeenCalledWith('42', {
            encodedPolyline: POLYLINE,
            at: expect.any(Number),
        });
    });

    it('stays quiet while the driver is on the cached route', async () => {
        await service.routeForOrder('42', ON_PATH, DEST); // seeds the cache

        await service.maybeRefreshRoute('42', { lat: 40.7, lng: -120.95 }, DEST);

        expect(fetchMock).toHaveBeenCalledTimes(1); // only the seed call
        expect(gateway.emitDeliveryRoute).not.toHaveBeenCalled();
    });

    it('recomputes and pushes when the driver leaves the route — throttled to one call per 20 s', async () => {
        await service.routeForOrder('42', ON_PATH, DEST);
        fetchMock.mockResolvedValue(googleOk('_p~iF~ps|U', 999, '300s')); // rerouted line

        vi.setSystemTime(1_000_000 + 21_000);
        await service.maybeRefreshRoute('42', OFF_PATH, DEST);
        await service.maybeRefreshRoute('42', OFF_PATH, DEST); // still off, but too soon

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(gateway.emitDeliveryRoute).toHaveBeenCalledTimes(1);
        expect(gateway.emitDeliveryRoute).toHaveBeenCalledWith('42', {
            encodedPolyline: '_p~iF~ps|U',
            at: expect.any(Number),
        });
    });

    it('clear() forgets the order so the next query recomputes', async () => {
        await service.routeForOrder('42', ON_PATH, DEST);
        service.clear('42');

        await service.routeForOrder('42', ON_PATH, DEST);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
