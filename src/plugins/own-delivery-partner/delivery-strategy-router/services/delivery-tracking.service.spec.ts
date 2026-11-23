import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

import { ForbiddenError, FulfillmentStateTransitionEvent } from '@vendure/core';
import { FindOperator } from 'typeorm';

import { DeliveryRide } from '../entities/delivery-ride.entity';
import { DriverStatus } from '../entities/driver-status.entity';
import { DeliveryTrackingService } from './delivery-tracking.service';

/**
 * Customer-facing tracking: the order's owner (and only the owner) can read
 * where their delivery is and get a socket ticket for that one order.
 */
describe('DeliveryTrackingService — customer tracking', () => {
    const ctx = { channelId: 1, activeUserId: 99, authorizedAsOwnerOnly: true } as any;
    const order = {
        id: 42,
        code: 'KK-42',
        state: 'OutforDelivery',
        customer: { user: { id: 99 } },
        shippingAddress: { customFields: { latitude: 9.95, longitude: 78.12 } },
    };
    const dest = { lat: 9.95, lng: 78.12 };

    let rides: any[];
    let statuses: any[];
    /** Raw row returned by the Fulfillment query builder (null = no fulfillment). */
    let fulfillmentRow: any;
    /** Captured event handlers, keyed by event class. */
    let handlers: Map<any, (e: any) => Promise<void> | void>;

    let fleetGateway: any;
    let orderService: any;
    let routeService: any;
    let canAccessOrder: ReturnType<typeof vi.fn>;
    /** The gateway's driver-fix sink, captured at bootstrap. */
    let fixSink: ((fix: any) => void) | null;
    let service: DeliveryTrackingService;

    function matches(row: any, where: Record<string, any>): boolean {
        return Object.entries(where).every(([key, value]) => {
            if (value instanceof FindOperator) {
                if (value.type === 'isNull') return row[key] == null;
                throw new Error(`unsupported operator ${value.type}`);
            }
            return String(row[key]) === String(value);
        });
    }

    function fakeRepo(rows: any[]) {
        return {
            find: vi.fn(async ({ where }: any) => rows.filter(r => matches(r, where))),
            findOne: vi.fn(async ({ where }: any) => rows.find(r => matches(r, where)) ?? null),
            save: vi.fn(async (entity: any) => {
                if (!entity.id) entity.id = rows.length + 1;
                const idx = rows.findIndex(r => r.id === entity.id);
                if (idx >= 0) rows[idx] = entity;
                else rows.push(entity);
                return entity;
            }),
            update: vi.fn(async (id: any, patch: any) => {
                const row = rows.find(r => r.id === id);
                if (row) Object.assign(row, patch);
            }),
            delete: vi.fn(async (ids: any[]) => {
                for (const id of ids) {
                    const idx = rows.findIndex(r => String(r.id) === String(id));
                    if (idx >= 0) rows.splice(idx, 1);
                }
            }),
        };
    }

    /** Chainable query-builder stub whose terminal call returns `result`. */
    function fakeQueryBuilder(result: any) {
        const chain: any = {};
        for (const m of ['innerJoin', 'select', 'addSelect', 'where', 'andWhere', 'limit', 'orderBy']) {
            chain[m] = vi.fn(() => chain);
        }
        chain.getRawOne = vi.fn(async () => result);
        return chain;
    }

    beforeEach(() => {
        rides = [];
        statuses = [];
        fulfillmentRow = null;
        handlers = new Map();

        const rideRepo = fakeRepo(rides);
        const statusRepo = fakeRepo(statuses);
        const connection = {
            rawConnection: {
                getRepository: vi.fn((entity: any) => {
                    if (entity === DeliveryRide) return rideRepo;
                    if (entity === DriverStatus) return statusRepo;
                    throw new Error('unexpected entity');
                }),
            },
            getRepository: vi.fn((_ctx: any, name: string) => ({
                createQueryBuilder: () =>
                    fakeQueryBuilder(
                        name === 'Fulfillment'
                            ? fulfillmentRow
                            : {
                                  id: order.id,
                                  code: order.code,
                                  state: order.state,
                                  orderId: String(order.id),
                                  orderCode: order.code,
                                  shippingAddress: JSON.stringify(order.shippingAddress),
                              },
                    ),
            })),
        };
        const eventBus = {
            ofType: vi.fn((klass: any) => ({ subscribe: (fn: any) => handlers.set(klass, fn) })),
        };
        const deliveryPartnerService = {
            getAdministratorIdFromUser: vi.fn(async () => '7'),
            getDeliveryPersons: vi.fn(async () => []),
        };
        fixSink = null;
        fleetGateway = {
            setDriverFixSink: vi.fn((sink: any) => (fixSink = sink)),
            hasViewers: vi.fn(() => false),
            hasOrderWatchers: vi.fn(() => true),
            emitDriverUpdate: vi.fn(),
            emitDeliveryLive: vi.fn(),
            emitDeliveryStatus: vi.fn(),
            issueCustomerTicket: vi.fn(() => 'ticket-1'),
        };
        routeService = {
            routeForOrder: vi.fn(async () => ({ encodedPolyline: 'poly-1', distanceMeters: 1500, durationSeconds: 300 })),
            maybeRefreshRoute: vi.fn(async () => undefined),
            clear: vi.fn(),
        };
        orderService = {
            findOneByCode: vi.fn(async (_ctx: any, code: string) => (code === order.code ? order : undefined)),
        };
        canAccessOrder = vi.fn(async () => true);
        const configService = { orderOptions: { orderByCodeAccessStrategy: { canAccessOrder } } };

        service = new DeliveryTrackingService(
            connection as any,
            eventBus as any,
            deliveryPartnerService as any,
            fleetGateway,
            orderService,
            configService as any,
            routeService,
        );
        service.onApplicationBootstrap();
    });

    it('refuses an unknown order code', async () => {
        await expect(service.customerTracking(ctx, 'NOPE')).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a customer the access strategy rejects, without issuing a ticket', async () => {
        canAccessOrder.mockResolvedValue(false);

        await expect(service.customerTracking(ctx, 'KK-42')).rejects.toBeInstanceOf(ForbiddenError);
        expect(fleetGateway.issueCustomerTicket).not.toHaveBeenCalled();
    });

    it('reports an inactive delivery with no ticket when nobody is riding with the order', async () => {
        const result = await service.customerTracking(ctx, 'KK-42');

        expect(result).toEqual({
            active: false,
            lat: null,
            lng: null,
            updatedAt: null,
            socketTicket: null,
            routePolyline: null,
        });
        expect(fleetGateway.issueCustomerTicket).not.toHaveBeenCalled();
    });

    it('returns the rider position and an order-bound ticket during a ride — nothing identifying the rider', async () => {
        const at = new Date('2026-09-01T10:00:00Z');
        rides.push({ id: 1, administratorId: '7', orderId: '42', orderCode: 'KK-42', channelId: '1', startedAt: at, deliveredAt: null, distanceMeters: 0 });
        statuses.push({ id: 1, administratorId: '7', channelId: '1', lat: 9.93, lng: 76.26, gpsOn: true, lastHeartbeatAt: at });

        const result = await service.customerTracking(ctx, 'KK-42');

        expect(result).toEqual({
            active: true,
            lat: 9.93,
            lng: 76.26,
            updatedAt: at,
            socketTicket: 'ticket-1',
            routePolyline: 'poly-1',
        });
        expect(fleetGateway.issueCustomerTicket).toHaveBeenCalledWith('1', '42');
        expect(routeService.routeForOrder).toHaveBeenCalledWith('42', { lat: 9.93, lng: 76.26 }, dest);
    });

    it('skips routing when the address has no pin or the rider has no fix yet', async () => {
        const at = new Date('2026-09-01T10:00:00Z');
        rides.push({ id: 1, administratorId: '7', orderId: '42', orderCode: 'KK-42', channelId: '1', startedAt: at, deliveredAt: null, distanceMeters: 0 });

        // No DriverStatus row → no rider position → no route to compute
        let result = await service.customerTracking(ctx, 'KK-42');
        expect(result.routePolyline).toBeNull();
        expect(routeService.routeForOrder).not.toHaveBeenCalled();

        // Rider known but the address has no pin → still no route
        statuses.push({ id: 1, administratorId: '7', channelId: '1', lat: 9.93, lng: 76.26, gpsOn: true, lastHeartbeatAt: at });
        (order.shippingAddress as any).customFields = {};
        result = await service.customerTracking(ctx, 'KK-42');
        expect(result.routePolyline).toBeNull();
        expect(routeService.routeForOrder).not.toHaveBeenCalled();
        (order.shippingAddress as any).customFields = { latitude: 9.95, longitude: 78.12 };
    });

    it('relays a heartbeat position to the order the driver is riding with', async () => {
        rides.push({ id: 1, administratorId: '7', orderId: '42', orderCode: 'KK-42', channelId: '1', startedAt: new Date(), deliveredAt: null, distanceMeters: 0 });

        await service.heartbeat(ctx, { lat: 9.9, lng: 76.2, gpsOn: true });

        expect(fleetGateway.emitDeliveryLive).toHaveBeenCalledWith('42', {
            lat: 9.9,
            lng: 76.2,
            heading: null,
            at: expect.any(Number),
        });
        // …and keeps the watchers' route honest (they exist in this test)
        expect(routeService.maybeRefreshRoute).toHaveBeenCalledWith('42', { lat: 9.9, lng: 76.2 }, dest);
    });

    it('does not resolve a route on heartbeat when nobody watches the order', async () => {
        fleetGateway.hasOrderWatchers.mockReturnValue(false);
        rides.push({ id: 1, administratorId: '7', orderId: '42', orderCode: 'KK-42', channelId: '1', startedAt: new Date(), deliveredAt: null, distanceMeters: 0 });

        await service.heartbeat(ctx, { lat: 9.9, lng: 76.2, gpsOn: true });

        expect(routeService.maybeRefreshRoute).not.toHaveBeenCalled();
    });

    it('refreshes the route from streamed ride fixes too', async () => {
        rides.push({ id: 1, administratorId: '7', orderId: '42', orderCode: 'KK-42', channelId: '1', startedAt: new Date(), deliveredAt: null, distanceMeters: 0 });

        fixSink!({ channelId: '1', administratorId: '7', lat: 9.91, lng: 76.21, heading: null, orderId: '42', rideDistanceMeters: null });
        await new Promise(resolve => setImmediate(resolve));

        expect(routeService.maybeRefreshRoute).toHaveBeenCalledWith('42', { lat: 9.91, lng: 76.21 }, dest);
    });

    it('does not relay a heartbeat when the driver is not riding', async () => {
        await service.heartbeat(ctx, { lat: 9.9, lng: 76.2, gpsOn: true });

        expect(fleetGateway.emitDeliveryLive).not.toHaveBeenCalled();
    });

    it('tells the order watchers when the delivery completes', async () => {
        rides.push({ id: 1, administratorId: '7', orderId: '42', orderCode: 'KK-42', channelId: '1', startedAt: new Date(), deliveredAt: null, distanceMeters: 0 });
        fulfillmentRow = { id: 'f1', orderId: '42', orderCode: 'KK-42' };

        await handlers.get(FulfillmentStateTransitionEvent)!({
            ctx,
            toState: 'Delivered',
            fulfillment: { id: 'f1', customFields: { deliveryPersonId: '7' } },
        });

        expect(fleetGateway.emitDeliveryStatus).toHaveBeenCalledWith('42', 'delivered');
        expect(routeService.clear).toHaveBeenCalledWith('42');
    });
});
