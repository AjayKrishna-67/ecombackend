import { beforeEach, describe, expect, it, vi } from 'vitest';

// Silence the Vendure Logger during tests (mirrors delivery-qr-code.service.spec)
vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

import {
    AdministratorEvent,
    FulfillmentStateTransitionEvent,
    OrderStateTransitionEvent,
} from '@vendure/core';

import { DeliveryPartnerService } from './delivery-partner.service';

/**
 * Cache layer correctness tests.
 *
 * Contract under test:
 *  - The cache stores ONLY primitive IDs + counts (avoiding entity-getter
 *    serialization issues with Vendure's RedisCacheStrategy).
 *  - On cache miss, the heavy `listQueryBuilder.build` path runs (filter + sort + count).
 *  - On cache hit, the heavy path is skipped; entities are re-hydrated by PK
 *    via a cheap `connection.getRepository(Order).createQueryBuilder` call.
 *  - Tag-based invalidation flushes only the affected channel/DP scope.
 */
describe('DeliveryPartnerService — cache layer', () => {
    /** In-memory store backing the mocked CacheService. */
    let cacheStore: Map<string, { value: any; tags: string[] }>;
    /** Captured event handlers, keyed by event class. */
    let eventSubscribers: Map<any, Array<(e: any) => void>>;

    let cacheService: any;
    let eventBus: any;
    let connection: any;
    let listQueryBuilder: any;
    let orderService: any;

    /** Spy on the heavy filtered-query path (cache miss only). */
    let ordersGetManyAndCount: ReturnType<typeof vi.fn>;
    /** Spy on the cheap PK re-hydration path (cache hit). */
    let orderRepoCreateQB: ReturnType<typeof vi.fn>;
    /** Spy on the delivery-persons DB call. */
    let dpGetMany: ReturnType<typeof vi.fn>;
    /** Spy on fulfillment cache-miss / cache-hit paths. */
    let fulfillmentGetMany: ReturnType<typeof vi.fn>;
    let fulfillmentRepoCreateQB: ReturnType<typeof vi.fn>;

    let service: DeliveryPartnerService;

    function fireEvent(klass: any, event: any) {
        const subs = eventSubscribers.get(klass) ?? [];
        subs.forEach(fn => fn(event));
    }

    /** Wait for fire-and-forget cache invalidation microtasks to drain. */
    const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

    beforeEach(() => {
        cacheStore = new Map();
        eventSubscribers = new Map();

        // ─── CacheService mock — real tag-based invalidation semantics ───
        cacheService = {
            get: vi.fn(async (key: string) => cacheStore.get(key)?.value),
            set: vi.fn(async (key: string, value: any, opts?: { ttl?: number; tags?: string[] }) => {
                cacheStore.set(key, { value, tags: opts?.tags ?? [] });
            }),
            invalidateTags: vi.fn(async (tags: string[]) => {
                for (const [key, entry] of cacheStore.entries()) {
                    if (entry.tags.some(t => tags.includes(t))) {
                        cacheStore.delete(key);
                    }
                }
            }),
        };

        // ─── EventBus mock — captures handlers per event class ───
        eventBus = {
            ofType: (klass: any) => ({
                subscribe: (fn: (e: any) => void) => {
                    const arr = eventSubscribers.get(klass) ?? [];
                    arr.push(fn);
                    eventSubscribers.set(klass, arr);
                    return { unsubscribe: () => undefined };
                },
            }),
        };

        // ─── ListQueryBuilder mock — heavy filtered-query path (cache miss) ───
        ordersGetManyAndCount = vi.fn().mockResolvedValue([
            [{ id: 1, code: 'O-1' }, { id: 2, code: 'O-2' }],
            2,
        ]);
        const listQbResult: any = {
            leftJoinAndSelect: vi.fn(() => listQbResult),
            leftJoin: vi.fn(() => listQbResult),
            andWhere: vi.fn(() => listQbResult),
            getManyAndCount: ordersGetManyAndCount,
        };
        listQueryBuilder = { build: vi.fn().mockReturnValue(listQbResult) };

        // ─── Order repo (cheap PK re-hydration on cache hit) ───
        const orderRepoQb: any = {
            leftJoinAndSelect: vi.fn(() => orderRepoQb),
            leftJoin: vi.fn(() => orderRepoQb),
            where: vi.fn(() => orderRepoQb),
            getMany: vi.fn().mockResolvedValue([
                { id: 1, code: 'O-1' },
                { id: 2, code: 'O-2' },
            ]),
        };
        orderRepoCreateQB = vi.fn().mockReturnValue(orderRepoQb);
        const orderRepo = { createQueryBuilder: orderRepoCreateQB };

        // ─── Administrator repo (DP list) ───
        dpGetMany = vi.fn().mockResolvedValue([
            {
                id: 100,
                firstName: 'A',
                lastName: 'B',
                emailAddress: 'a@b.c',
                customFields: { phoneNumber: '+919999999999' },
                user: { id: 200 },
            },
        ]);
        const dpQb: any = {
            leftJoinAndSelect: vi.fn(() => dpQb),
            innerJoin: vi.fn(() => dpQb),
            where: vi.fn(() => dpQb),
            andWhere: vi.fn(() => dpQb),
            select: vi.fn(() => dpQb),
            getMany: dpGetMany,
            getOne: vi.fn().mockResolvedValue(null),
            getRawOne: vi.fn().mockResolvedValue(null),
        };
        const adminRepo = { createQueryBuilder: vi.fn().mockReturnValue(dpQb) };

        // ─── Fulfillment repo (used by both miss and hit paths) ───
        fulfillmentGetMany = vi.fn().mockResolvedValue([
            { id: 7000, state: 'OutforDelivery' },
            { id: 7001, state: 'Delivered' },
        ]);
        const fulfillmentQb: any = {
            innerJoinAndSelect: vi.fn(() => fulfillmentQb),
            innerJoin: vi.fn(() => fulfillmentQb),
            leftJoinAndSelect: vi.fn(() => fulfillmentQb),
            where: vi.fn(() => fulfillmentQb),
            andWhere: vi.fn(() => fulfillmentQb),
            orderBy: vi.fn(() => fulfillmentQb),
            getMany: fulfillmentGetMany,
        };
        fulfillmentRepoCreateQB = vi.fn().mockReturnValue(fulfillmentQb);
        const fulfillmentRepo = { createQueryBuilder: fulfillmentRepoCreateQB };

        connection = {
            getRepository: vi.fn((_ctx: any, entity: any) => {
                if (entity === 'Administrator') return adminRepo;
                if (entity === 'Fulfillment') return fulfillmentRepo;
                // Order class or anything else
                return orderRepo;
            }),
        };

        orderService = { createFulfillment: vi.fn() };

        service = new DeliveryPartnerService(
            connection,
            orderService,
            listQueryBuilder,
            cacheService,
            eventBus,
        );
        service.onApplicationBootstrap();
    });

    const makeCtx = (channelId: number, activeUserId = 99) =>
        ({ channelId, activeUserId } as any);

    // ─── getDeliveryOrders ────────────────────────────────────────────

    describe('getDeliveryOrders', () => {
        it('runs the heavy filtered query on the first call (cache miss)', async () => {
            await service.getDeliveryOrders(makeCtx(5), { skip: 0, take: 10 });

            expect(listQueryBuilder.build).toHaveBeenCalledTimes(1);
            expect(cacheService.set).toHaveBeenCalledTimes(1);
        });

        it('caches IDs + totalItems (NOT entities) to dodge serialization', async () => {
            await service.getDeliveryOrders(makeCtx(5), { skip: 0, take: 10 });

            const setCall = (cacheService.set as any).mock.calls[0];
            const cachedValue = setCall[1];
            expect(cachedValue).toEqual({ ids: [1, 2], totalItems: 2 });
        });

        it('skips the heavy query on the second identical call (cache hit)', async () => {
            await service.getDeliveryOrders(makeCtx(5), { skip: 0, take: 10 });
            await service.getDeliveryOrders(makeCtx(5), { skip: 0, take: 10 });

            // Heavy filtered-query ran exactly once
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(1);
            // Re-hydration via PK ran on the second (cache-hit) call
            expect(orderRepoCreateQB).toHaveBeenCalledTimes(1);
        });

        it('uses separate cache entries for different filter shapes', async () => {
            const ctx = makeCtx(5);
            await service.getDeliveryOrders(ctx, { skip: 0, take: 10 });
            await service.getDeliveryOrders(ctx, { skip: 0, take: 500 });
            await service.getDeliveryOrders(ctx, { skip: 0, take: 10, postalCode: '600028' });

            expect(listQueryBuilder.build).toHaveBeenCalledTimes(3);
        });

        it('uses separate cache entries per channel', async () => {
            await service.getDeliveryOrders(makeCtx(5), { take: 10 });
            await service.getDeliveryOrders(makeCtx(6), { take: 10 });

            expect(listQueryBuilder.build).toHaveBeenCalledTimes(2);
        });

        it('returns the same totalItems from cache as from the DB', async () => {
            const first = await service.getDeliveryOrders(makeCtx(5), { take: 10 });
            const second = await service.getDeliveryOrders(makeCtx(5), { take: 10 });

            expect(second.totalItems).toBe(first.totalItems);
            expect(second.totalItems).toBe(2);
        });
    });

    // ─── Cache invalidation via events ───────────────────────────────

    describe('event-driven invalidation', () => {
        it('OrderStateTransitionEvent flushes the orders cache for that channel', async () => {
            const ctx = makeCtx(5);
            await service.getDeliveryOrders(ctx, { take: 10 });
            await service.getDeliveryOrders(ctx, { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(1);

            fireEvent(OrderStateTransitionEvent, { ctx: { channelId: 5 } });
            await flushMicrotasks();

            await service.getDeliveryOrders(ctx, { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(2); // forced miss
        });

        it('OrderStateTransitionEvent for channel A does NOT flush channel B', async () => {
            await service.getDeliveryOrders(makeCtx(5), { take: 10 });
            await service.getDeliveryOrders(makeCtx(6), { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(2);

            fireEvent(OrderStateTransitionEvent, { ctx: { channelId: 5 } });
            await flushMicrotasks();

            // Channel 6 still cached
            await service.getDeliveryOrders(makeCtx(6), { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(2);

            // Channel 5 must miss
            await service.getDeliveryOrders(makeCtx(5), { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(3);
        });

        it('FulfillmentStateTransitionEvent invalidates both channel orders and the assigned DP cache', async () => {
            const ctx = makeCtx(5);
            await service.getDeliveryOrders(ctx, { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(1);

            fireEvent(FulfillmentStateTransitionEvent, {
                ctx: { channelId: 5 },
                fulfillment: { customFields: { deliveryPersonId: '42' } },
            });
            await flushMicrotasks();

            expect(cacheService.invalidateTags).toHaveBeenCalledWith(
                expect.arrayContaining([
                    'delivery-partner:orders:channel:5',
                    'delivery-partner:my-fulfillments:dp:42',
                ]),
            );

            await service.getDeliveryOrders(ctx, { take: 10 });
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(2);
        });
    });

    // ─── getDeliveryPersons ──────────────────────────────────────────

    describe('getDeliveryPersons', () => {
        it('caches the DP list and skips the DB on the second call', async () => {
            await service.getDeliveryPersons(makeCtx(5));
            await service.getDeliveryPersons(makeCtx(5));

            expect(dpGetMany).toHaveBeenCalledTimes(1);
        });

        it('AdministratorEvent invalidates the DP list across all channels', async () => {
            await service.getDeliveryPersons(makeCtx(5));
            await service.getDeliveryPersons(makeCtx(6));
            expect(dpGetMany).toHaveBeenCalledTimes(2);

            fireEvent(AdministratorEvent, {});
            await flushMicrotasks();

            await service.getDeliveryPersons(makeCtx(5));
            await service.getDeliveryPersons(makeCtx(6));
            expect(dpGetMany).toHaveBeenCalledTimes(4);
        });
    });

    // ─── Realistic workload ──────────────────────────────────────────

    describe('throughput simulation', () => {
        it('with 10 sequential identical requests, the heavy query runs only once', async () => {
            const ctx = makeCtx(5);
            await service.getDeliveryOrders(ctx, { take: 10 });
            for (let i = 0; i < 9; i++) {
                await service.getDeliveryOrders(ctx, { take: 10 });
            }
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(1);
            // 9 cache-hit re-hydrations
            expect(orderRepoCreateQB).toHaveBeenCalledTimes(9);
        });

        it('cache hit ratio across mixed traffic stays high', async () => {
            const ctx = makeCtx(5);
            // 2 distinct cold loads: one for the postal-codes query (take 500),
            // one for the table query (take 10).
            await service.getDeliveryOrders(ctx, { take: 500 });
            await service.getDeliveryOrders(ctx, { take: 10 });
            // 18 admin views in the same TTL window — 9 of each
            for (let i = 0; i < 9; i++) {
                await service.getDeliveryOrders(ctx, { take: 500 });
                await service.getDeliveryOrders(ctx, { take: 10 });
            }

            // Heavy query ran twice (one per distinct cache key)
            expect(listQueryBuilder.build).toHaveBeenCalledTimes(2);
            const totalRequests = 20;
            const heavyHits = (listQueryBuilder.build as any).mock.calls.length;
            const hitRatio = (totalRequests - heavyHits) / totalRequests;
            expect(hitRatio).toBeGreaterThanOrEqual(0.9);
        });
    });
});
