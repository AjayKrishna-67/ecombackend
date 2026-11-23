import { randomUUID } from 'crypto';
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@vendure/core';
import type { Server, Socket } from 'socket.io';

const loggerCtx = 'FleetGateway';

/** Tickets die after this long — issued immediately before connecting. */
const TICKET_TTL_MS = 60 * 1000;

interface FleetTicket {
    channelId: string;
    /**
     * viewer = fleet page (joins the channel room); driver = rider streaming
     * ride fixes; customer = order owner watching ONE delivery (joins only
     * that order's room — never the channel room).
     */
    role: 'viewer' | 'driver' | 'customer';
    administratorId?: string;
    /** customer tickets only — the single order room this socket may join */
    orderId?: string;
    expiresAt: number;
}

/**
 * What a CUSTOMER receives about their delivery: position only. No driver
 * id, no odometer — nothing that identifies or profiles the rider.
 */
export interface DeliveryLivePayload {
    lat: number;
    lng: number;
    heading: number | null;
    at: number;
}

/** A live GPS fix streamed by a riding driver over their socket. */
export interface DriverLiveFix {
    channelId: string;
    administratorId: string;
    lat: number;
    lng: number;
    heading: number | null;
    orderId: string | null;
    rideDistanceMeters: number | null;
}

/**
 * Socket.IO gateway that pushes live fleet updates to admin viewers.
 *
 * Shares Vendure's HTTP server (same port), path /fleet-io. Three kinds of
 * socket: fleet VIEWERS (owner's browser, channel room), riding DRIVERS
 * (stream fixes in), and CUSTOMERS (storefront/app order page, one order
 * room each — they see their own delivery's position and nothing else).
 *
 * Auth is ticket-based: the socket handshake cannot reuse Vendure's GraphQL
 * auth pipeline, so instead of re-implementing session-cookie parsing here,
 * the client first calls the `fleetSocketTicket` query (normal cookie auth +
 * permission check happen THERE) and connects with the returned one-time
 * ticket. The ticket binds the socket to the channel it was issued for, so a
 * viewer only ever joins their own channel's room.
 *
 * Worker-safety: in the worker process there is no HTTP server, so Nest never
 * initializes this gateway's server — every emit is guarded with `?.`.
 */
@WebSocketGateway({
    path: '/fleet-io',
    cors: { origin: true, credentials: true },
    transports: ['websocket', 'polling'],
})
export class FleetGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server?: Server;

    private tickets = new Map<string, FleetTicket>();

    /** Sink for persisting streamed fixes — registered by DeliveryTrackingService
     *  at bootstrap (callback instead of injection to avoid a DI cycle). */
    private driverFixSink: ((fix: DriverLiveFix) => void) | null = null;

    setDriverFixSink(sink: (fix: DriverLiveFix) => void): void {
        this.driverFixSink = sink;
    }

    // ─── Ticket issuing (called by the GraphQL resolver, already authed) ───

    issueTicket(channelId: string): string {
        return this.storeTicket({ channelId, role: 'viewer', expiresAt: 0 });
    }

    issueDriverTicket(channelId: string, administratorId: string): string {
        return this.storeTicket({ channelId, role: 'driver', administratorId, expiresAt: 0 });
    }

    /** Ticket for an order's owner — the socket may join that order's room only. */
    issueCustomerTicket(channelId: string, orderId: string): string {
        return this.storeTicket({ channelId, role: 'customer', orderId, expiresAt: 0 });
    }

    private storeTicket(ticket: Omit<FleetTicket, 'expiresAt'> & { expiresAt: number }): string {
        // Opportunistic sweep so abandoned tickets never accumulate
        const now = Date.now();
        for (const [key, t] of this.tickets) {
            if (t.expiresAt < now) this.tickets.delete(key);
        }
        const id = randomUUID();
        this.tickets.set(id, { ...ticket, expiresAt: now + TICKET_TTL_MS });
        return id;
    }

    private consumeTicket(ticket: unknown): FleetTicket | null {
        if (typeof ticket !== 'string') return null;
        const entry = this.tickets.get(ticket);
        if (!entry) return null;
        this.tickets.delete(ticket); // single-use
        return entry.expiresAt >= Date.now() ? entry : null;
    }

    // ─── Connection lifecycle ─────────────────────────────────────────

    handleConnection(socket: Socket) {
        const entry = this.consumeTicket(socket.handshake.auth?.ticket);
        if (!entry) {
            Logger.warn('Fleet socket rejected — missing/invalid ticket', loggerCtx);
            socket.disconnect(true);
            return;
        }
        if (entry.role === 'viewer') {
            void socket.join(this.room(entry.channelId));
            Logger.debug(`Fleet viewer connected (channel ${entry.channelId})`, loggerCtx);
        } else if (entry.role === 'customer') {
            if (!entry.orderId) {
                socket.disconnect(true);
                return;
            }
            void socket.join(this.orderRoom(entry.orderId));
            Logger.debug(`Customer connected (order ${entry.orderId})`, loggerCtx);
        } else {
            // Drivers don't join the room (they'd see other riders' fixes) —
            // their identity is pinned server-side for the ride-fix handler.
            socket.data.driver = {
                channelId: entry.channelId,
                administratorId: entry.administratorId ?? '',
            };
            Logger.debug(`Driver stream connected (admin ${entry.administratorId})`, loggerCtx);
        }
    }

    handleDisconnect() {
        // Rooms clean themselves up; nothing to do
    }

    /**
     * Live GPS fix from a riding driver (~every 2.5 s). Relayed to the
     * channel's fleet viewers IMMEDIATELY — no database on the hot path —
     * then handed to the tracking service, which throttles persistence.
     * Identity comes from the socket's ticket, never from the payload.
     */
    @SubscribeMessage('ride-fix')
    onRideFix(
        @ConnectedSocket() socket: Socket,
        @MessageBody() body: { lat?: number; lng?: number; heading?: number | null; orderId?: string; rideDistanceMeters?: number },
    ): void {
        const driver = socket.data?.driver as { channelId: string; administratorId: string } | undefined;
        if (!driver?.administratorId) return; // not a driver socket
        const lat = Number(body?.lat);
        const lng = Number(body?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const fix: DriverLiveFix = {
            channelId: driver.channelId,
            administratorId: driver.administratorId,
            lat,
            lng,
            heading: Number.isFinite(Number(body?.heading)) ? Number(body?.heading) : null,
            orderId: body?.orderId ? String(body.orderId) : null,
            rideDistanceMeters: Number.isFinite(Number(body?.rideDistanceMeters))
                ? Math.max(0, Math.round(Number(body?.rideDistanceMeters)))
                : null,
        };

        const at = Date.now();
        this.server?.to(this.room(driver.channelId)).emit('driver-live', {
            administratorId: fix.administratorId,
            lat: fix.lat,
            lng: fix.lng,
            heading: fix.heading,
            activeOrderId: fix.orderId,
            rideDistanceMeters: fix.rideDistanceMeters,
            at,
        });
        // The order's owner gets the same fix, stripped to position only
        if (fix.orderId) {
            this.emitDeliveryLive(fix.orderId, { lat: fix.lat, lng: fix.lng, heading: fix.heading, at });
        }

        this.driverFixSink?.(fix);
    }

    // ─── Emitting (called by DeliveryTrackingService) ─────────────────

    /** True when at least one viewer is watching this channel's fleet. */
    hasViewers(channelId: string): boolean {
        const room = this.server?.sockets?.adapter?.rooms?.get(this.room(channelId));
        return !!room && room.size > 0;
    }

    /** Push one driver's fresh fleet status to every viewer of the channel. */
    emitDriverUpdate(channelId: string, status: unknown): void {
        this.server?.to(this.room(channelId)).emit('driver-update', status);
    }

    /** Position push for whoever is watching this order (customer sockets). */
    emitDeliveryLive(orderId: string, payload: DeliveryLivePayload): void {
        this.server?.to(this.orderRoom(orderId)).emit('delivery-live', payload);
    }

    /** Tells the order's watchers the delivery ended — the map can stop. */
    emitDeliveryStatus(orderId: string, status: 'delivered' | 'cancelled'): void {
        this.server?.to(this.orderRoom(orderId)).emit('delivery-status', { status });
    }

    /** Fresh road route for the order's watchers (driver rerouted / first watcher). */
    emitDeliveryRoute(orderId: string, route: { encodedPolyline: string; at: number }): void {
        this.server?.to(this.orderRoom(orderId)).emit('delivery-route', route);
    }

    /** True when at least one customer socket is watching this order. */
    hasOrderWatchers(orderId: string): boolean {
        const room = this.server?.sockets?.adapter?.rooms?.get(this.orderRoom(orderId));
        return !!room && room.size > 0;
    }

    private room(channelId: string): string {
        return `channel:${channelId}`;
    }

    private orderRoom(orderId: string): string {
        return `order:${orderId}`;
    }
}
