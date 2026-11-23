import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

import { FleetGateway } from './fleet.gateway';

/**
 * Customer-facing rooms: a customer ticket must land ONLY in its own order's
 * room, and what reaches that room must never identify the driver.
 */
describe('FleetGateway — per-order customer rooms', () => {
    let gateway: FleetGateway;
    /** Every emit, in order: which room, which event, what payload. */
    let emits: Array<{ room: string; event: string; payload: any }>;

    function fakeSocket(ticket: string) {
        return {
            handshake: { auth: { ticket } },
            join: vi.fn(),
            disconnect: vi.fn(),
            data: {},
        } as any;
    }

    beforeEach(() => {
        emits = [];
        gateway = new FleetGateway();
        gateway.server = {
            to: vi.fn((room: string) => ({
                emit: (event: string, payload: any) => emits.push({ room, event, payload }),
            })),
            sockets: { adapter: { rooms: new Map() } },
        } as any;
    });

    it('joins a customer socket to its order room only', () => {
        const ticket = gateway.issueCustomerTicket('1', '42');
        const socket = fakeSocket(ticket);

        gateway.handleConnection(socket);

        expect(socket.disconnect).not.toHaveBeenCalled();
        expect(socket.join).toHaveBeenCalledTimes(1);
        expect(socket.join).toHaveBeenCalledWith('order:42');
    });

    it('relays a ride fix to the order room without identifying the driver', () => {
        const driver = fakeSocket(gateway.issueDriverTicket('1', '7'));
        gateway.handleConnection(driver);

        gateway.onRideFix(driver, { lat: 9.93, lng: 76.26, heading: 90, orderId: '42', rideDistanceMeters: 1200 });

        const toOrder = emits.filter(e => e.room === 'order:42');
        expect(toOrder).toHaveLength(1);
        expect(toOrder[0].event).toBe('delivery-live');
        expect(toOrder[0].payload).toEqual({ lat: 9.93, lng: 76.26, heading: 90, at: expect.any(Number) });
        // The channel (fleet) room still gets its full update
        expect(emits.some(e => e.room === 'channel:1' && e.event === 'driver-live')).toBe(true);
    });

    it('does not touch any order room for a fix without an order', () => {
        const driver = fakeSocket(gateway.issueDriverTicket('1', '7'));
        gateway.handleConnection(driver);

        gateway.onRideFix(driver, { lat: 9.93, lng: 76.26 });

        expect(emits.filter(e => e.room.startsWith('order:'))).toHaveLength(0);
    });

    it('pushes a heartbeat position to the order room', () => {
        gateway.emitDeliveryLive('42', { lat: 9.9, lng: 76.2, heading: null, at: 1000 });

        expect(emits).toEqual([
            { room: 'order:42', event: 'delivery-live', payload: { lat: 9.9, lng: 76.2, heading: null, at: 1000 } },
        ]);
    });

    it('pushes the delivery outcome to the order room', () => {
        gateway.emitDeliveryStatus('42', 'delivered');

        expect(emits).toEqual([{ room: 'order:42', event: 'delivery-status', payload: { status: 'delivered' } }]);
    });

    it('pushes a recomputed route to the order room', () => {
        gateway.emitDeliveryRoute('42', { encodedPolyline: 'abc', at: 123 });

        expect(emits).toEqual([
            { room: 'order:42', event: 'delivery-route', payload: { encodedPolyline: 'abc', at: 123 } },
        ]);
    });

    it('knows whether an order room has watchers', () => {
        const rooms = (gateway.server as any).sockets.adapter.rooms as Map<string, Set<string>>;
        rooms.set('order:42', new Set(['socket-1']));

        expect(gateway.hasOrderWatchers('42')).toBe(true);
        expect(gateway.hasOrderWatchers('99')).toBe(false);
    });
});
