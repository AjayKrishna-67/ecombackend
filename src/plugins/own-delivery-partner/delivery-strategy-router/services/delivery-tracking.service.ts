import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    ConfigService,
    EventBus,
    ForbiddenError,
    FulfillmentStateTransitionEvent,
    ID,
    Logger,
    LogLevel,
    OrderService,
    OrderStateTransitionEvent,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { Brackets, IsNull } from 'typeorm';

import { DeliveryRide } from '../entities/delivery-ride.entity';
import { DriverStatus } from '../entities/driver-status.entity';
import { FleetGateway, DriverLiveFix } from '../api/fleet.gateway';
import { DeliveryPartnerService } from './delivery-partner.service';
import { DeliveryRouteService } from './delivery-route.service';
import { DriverAssignedOrder, OPEN_FULFILLMENT_STATES, toDriverAssignedOrders } from './driver-assigned-orders';
import { RoutePoint } from './route-geometry';

const loggerCtx = 'DeliveryTrackingService';

/** No heartbeat for this long ⇒ the app is closed / logged out ⇒ INACTIVE. */
const HEARTBEAT_STALE_MS = 60 * 1000;

/** Streamed ride fixes hit MySQL at most this often per driver — the socket
 *  relay to viewers is instant; the database is not on the hot path. */
const LIVE_FIX_FLUSH_MS = 15 * 1000;

export type DriverFleetState = 'OUT_FOR_DELIVERY' | 'ACTIVE' | 'INACTIVE';

export interface DriverHeartbeatInput {
    lat?: number | null;
    lng?: number | null;
    gpsOn: boolean;
    rideDistanceMeters?: number | null;
    orderId?: ID | null;
}

/** Shop-facing view of one order's delivery — see `customerTracking`. */
export interface OrderDeliveryTracking {
    active: boolean;
    lat: number | null;
    lng: number | null;
    updatedAt: Date | null;
    socketTicket: string | null;
    /** Encoded road route rider → shipping address (same line the rider sees). */
    routePolyline: string | null;
}

/**
 * Owns the three facts live tracking needs: who is riding which order
 * (DeliveryRide), where each driver last was (DriverStatus), and how far
 * they've traveled (distanceMeters, reported cumulatively by heartbeats).
 *
 * Rides are ALSO opened/closed automatically from fulfillment state events,
 * so the data stays truthful even if the PWA misses the explicit mutations
 * (killed app, flaky network): OutforDelivery ⇒ ensure open ride,
 * Delivered ⇒ close it. The explicit mutations then only carry the final km.
 */
@Injectable()
export class DeliveryTrackingService implements OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private eventBus: EventBus,
        private deliveryPartnerService: DeliveryPartnerService,
        private fleetGateway: FleetGateway,
        private orderService: OrderService,
        private configService: ConfigService,
        private deliveryRouteService: DeliveryRouteService,
    ) {}

    /** Per-driver timestamp of the last streamed-fix DB flush */
    private lastLiveFlush = new Map<string, number>();

    onApplicationBootstrap() {
        this.eventBus.ofType(FulfillmentStateTransitionEvent).subscribe(async event => {
            try {
                await this.onFulfillmentTransition(event);
            } catch (e: any) {
                Logger.error(`Ride auto-sync failed: ${e.message}`, loggerCtx);
            }
        });
        // Backstop for cancellations that never touch the fulfillment (admin
        // cancels the order directly): open rides must not survive a dead order.
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async event => {
            try {
                if ((event.toState as string) !== 'Cancelled') return;
                const admins = await this.abortOpenRides(String(event.order.id));
                for (const adminId of admins) {
                    await this.pushDriverUpdate(event.ctx, adminId);
                }
                if (admins.length > 0) {
                    this.fleetGateway.emitDeliveryStatus(String(event.order.id), 'cancelled');
                    this.deliveryRouteService.clear(String(event.order.id));
                }
            } catch (e: any) {
                Logger.error(`Ride cancel cleanup failed: ${e.message}`, loggerCtx);
            }
        });
        // Persist streamed ride fixes (throttled). Registered as a callback
        // instead of injecting this service into the gateway — avoids a DI cycle.
        this.fleetGateway.setDriverFixSink(fix => {
            void this.recordLiveFix(fix).catch((e: any) =>
                Logger.debug(`Live fix flush failed: ${e.message}`, loggerCtx),
            );
        });
    }

    /**
     * Throttled persistence for socket-streamed fixes: at most one MySQL
     * write per driver per LIVE_FIX_FLUSH_MS. Also stamps lastHeartbeatAt so
     * the fleet state derivation treats the stream as presence — while a
     * driver streams, no HTTP heartbeats are needed at all.
     */
    private async recordLiveFix(fix: DriverLiveFix): Promise<void> {
        const now = Date.now();
        const last = this.lastLiveFlush.get(fix.administratorId) ?? 0;
        if (now - last < LIVE_FIX_FLUSH_MS) {
            return;
        }
        this.lastLiveFlush.set(fix.administratorId, now);

        const repo = this.connection.rawConnection.getRepository(DriverStatus);
        const existing = await repo.findOne({
            where: { administratorId: fix.administratorId, channelId: fix.channelId },
        });
        const patch = {
            lat: fix.lat,
            lng: fix.lng,
            gpsOn: true,
            lastHeartbeatAt: new Date(),
        };
        if (existing) {
            await repo.update(existing.id, patch);
        } else {
            await repo.save(
                new DriverStatus({
                    administratorId: fix.administratorId,
                    channelId: fix.channelId,
                    ...patch,
                }),
            );
        }

        if (fix.rideDistanceMeters != null) {
            const qb = this.connection.rawConnection
                .getRepository(DeliveryRide)
                .createQueryBuilder()
                .update()
                .set({ distanceMeters: () => 'GREATEST(distanceMeters, :d)' })
                .where('administratorId = :adminId', { adminId: fix.administratorId })
                .andWhere('deliveredAt IS NULL')
                .setParameters({ d: fix.rideDistanceMeters });
            if (fix.orderId) {
                qb.andWhere('orderId = :orderId', { orderId: fix.orderId });
            }
            await qb.execute();
        }

        // Keep watching customers' road route truthful (reroutes push live).
        // Watcher check first — no customers, no order lookup, no Google.
        if (fix.orderId && this.fleetGateway.hasOrderWatchers(fix.orderId)) {
            const dest = await this.getOrderDestination(RequestContext.empty(), fix.orderId);
            if (dest) {
                await this.deliveryRouteService.maybeRefreshRoute(
                    fix.orderId,
                    { lat: fix.lat, lng: fix.lng },
                    dest,
                );
            }
        }
    }

    private async onFulfillmentTransition(event: FulfillmentStateTransitionEvent) {
        const toState = event.toState as string;
        if (toState !== 'OutforDelivery' && toState !== 'Delivered' && toState !== 'Cancelled') {
            return;
        }
        const dpId = (event.fulfillment as any).customFields?.deliveryPersonId;
        if (!dpId) {
            return;
        }
        const order = await this.getOrderFromFulfillment(event.ctx, event.fulfillment.id);
        if (!order) {
            return;
        }
        if (toState === 'OutforDelivery') {
            await this.ensureOpenRide(event.ctx, dpId, order.orderId, order.orderCode);
        } else if (toState === 'Delivered') {
            await this.closeOpenRide(event.ctx, dpId, order.orderId, undefined);
            this.fleetGateway.emitDeliveryStatus(order.orderId, 'delivered');
            this.deliveryRouteService.clear(order.orderId);
        } else {
            // Cancelled mid-ride: the delivery never happened — the open ride
            // is DELETED (not stamped delivered), so it can't pollute km/day,
            // can't leave the driver stuck OUT_FOR_DELIVERY on the fleet page,
            // and can't make activeRideForMe resume into a cancelled order.
            await this.abortOpenRides(order.orderId, String(dpId));
            this.fleetGateway.emitDeliveryStatus(order.orderId, 'cancelled');
            this.deliveryRouteService.clear(order.orderId);
        }
        await this.pushDriverUpdate(event.ctx, String(dpId));
    }

    /**
     * Delete open rides for an order (optionally scoped to one driver).
     * Returns the affected driver ids so callers can push fresh fleet states.
     */
    private async abortOpenRides(orderId: string, administratorId?: string): Promise<string[]> {
        const repo = this.connection.rawConnection.getRepository(DeliveryRide);
        const where: Record<string, unknown> = { orderId, deliveredAt: IsNull() };
        if (administratorId) {
            where.administratorId = administratorId;
        }
        const open = await repo.find({ where: where as any });
        if (open.length === 0) {
            return [];
        }
        await repo.delete(open.map(r => String(r.id)));
        Logger.info(`Aborted ${open.length} open ride(s) for cancelled order ${orderId}`, loggerCtx);
        return [...new Set(open.map(r => r.administratorId))];
    }

    // ─── Driver-facing operations ───

    /**
     * Upsert the driver's presence row and, when a cumulative ride odometer is
     * reported, fold it into the open ride (monotonic max — lost pings lose nothing).
     */
    async heartbeat(ctx: RequestContext, input: DriverHeartbeatInput) {
        const adminId = await this.deliveryPartnerService.getAdministratorIdFromUser(ctx);
        if (!adminId) {
            throw new UserInputError('No administrator found for the current user');
        }
        const repo = this.connection.rawConnection.getRepository(DriverStatus);
        const channelId = String(ctx.channelId);
        const existing = await repo.findOne({
            where: { administratorId: String(adminId), channelId },
        });
        const patch = {
            lat: input.lat ?? existing?.lat ?? null,
            lng: input.lng ?? existing?.lng ?? null,
            gpsOn: !!input.gpsOn,
            lastHeartbeatAt: new Date(),
        };
        if (existing) {
            await repo.update(existing.id, patch);
        } else {
            await repo.save(new DriverStatus({ administratorId: String(adminId), channelId, ...patch }));
        }

        if (input.rideDistanceMeters != null && input.rideDistanceMeters >= 0) {
            const qb = this.connection.rawConnection
                .getRepository(DeliveryRide)
                .createQueryBuilder()
                .update()
                .set({ distanceMeters: () => 'GREATEST(distanceMeters, :d)' })
                .where('administratorId = :adminId', { adminId: String(adminId) })
                .andWhere('deliveredAt IS NULL')
                .setParameters({ d: Math.round(input.rideDistanceMeters) });
            if (input.orderId) {
                qb.andWhere('orderId = :orderId', { orderId: String(input.orderId) });
            }
            await qb.execute();
        }

        // While riding, the order's owner sees this position too. Heartbeats
        // are the 20 s fallback cadence when the ride stream is down, so the
        // customer's marker keeps moving (coarsely) instead of freezing.
        if (patch.lat != null && patch.lng != null) {
            const openRide = await this.connection.rawConnection.getRepository(DeliveryRide).findOne({
                where: { administratorId: String(adminId), channelId, deliveredAt: IsNull() },
                order: { startedAt: 'DESC' },
            });
            if (openRide) {
                this.fleetGateway.emitDeliveryLive(openRide.orderId, {
                    lat: patch.lat,
                    lng: patch.lng,
                    heading: null,
                    at: Date.now(),
                });
                if (this.fleetGateway.hasOrderWatchers(openRide.orderId)) {
                    const dest = await this.getOrderDestination(ctx, openRide.orderId);
                    if (dest) {
                        await this.deliveryRouteService.maybeRefreshRoute(
                            openRide.orderId,
                            { lat: patch.lat, lng: patch.lng },
                            dest,
                        );
                    }
                }
            }
        }

        await this.pushDriverUpdate(ctx, String(adminId));
        return { ok: true, serverTime: new Date() };
    }

    /**
     * Idempotent: returns the existing open ride for this (driver, order) if any.
     * Guarded: only the driver ASSIGNED to the order's delivery fulfillment can
     * open a ride for it — another delivery person's session cannot hijack or
     * duplicate someone else's delivery.
     */
    async startRide(ctx: RequestContext, orderId: ID) {
        const adminId = await this.requireAdminId(ctx);
        const order = await this.getOrderById(ctx, orderId);
        if (!order) {
            throw new UserInputError(`Order ${orderId} not found`);
        }
        const assigned = await this.isAssignedToOrder(ctx, String(adminId), String(order.id));
        if (!assigned) {
            throw new UserInputError(`Order ${order.code} is not assigned to you`);
        }
        const ride = await this.ensureOpenRide(ctx, String(adminId), String(order.id), order.code);
        await this.pushDriverUpdate(ctx, String(adminId));
        return this.mapRide(ride);
    }

    /** True when the order has a live delivery fulfillment assigned to this driver. */
    private async isAssignedToOrder(ctx: RequestContext, adminId: string, orderId: string): Promise<boolean> {
        const row = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .select('f.id', 'id')
            .where('o.id = :orderId', { orderId })
            .andWhere('f.customFieldsDeliverypersonid = :adminId', { adminId })
            .andWhere("f.state IN ('Shipped', 'OutforDelivery')")
            .limit(1)
            .getRawOne();
        return !!row?.id;
    }

    async completeRide(ctx: RequestContext, orderId: ID, finalDistanceMeters?: number | null) {
        const adminId = await this.requireAdminId(ctx);
        const ride = await this.closeOpenRide(ctx, String(adminId), String(orderId), finalDistanceMeters ?? undefined);
        await this.pushDriverUpdate(ctx, String(adminId));
        return this.mapRide(ride);
    }

    /**
     * One-time Socket.IO handshake ticket for the fleet page. Permission is
     * enforced at the resolver; the ticket binds the socket to this channel.
     */
    issueSocketTicket(ctx: RequestContext): string {
        return this.fleetGateway.issueTicket(String(ctx.channelId));
    }

    /**
     * One-time handshake ticket for a DRIVER's ride-streaming socket. Binds
     * the socket to this driver's identity — ride-fix events are attributed
     * server-side, never trusted from the payload.
     */
    async issueDriverSocketTicket(ctx: RequestContext): Promise<string> {
        const adminId = await this.requireAdminId(ctx);
        return this.fleetGateway.issueDriverTicket(String(ctx.channelId), String(adminId));
    }

    /**
     * The logged-in driver's most recent open ride — powers resume after
     * logout/app-kill.
     *
     * SELF-HEALING: an open ride whose order is gone or already terminal must
     * never be returned — the app would redirect into a dead delivery page,
     * which bounces back, and the two redirects loop forever (seen in the
     * field with a stale pre-fix ride row). Delivered orders close the ride
     * (km preserved); cancelled/missing orders delete it.
     */
    async activeRideForMe(ctx: RequestContext) {
        const adminId = await this.deliveryPartnerService.getAdministratorIdFromUser(ctx);
        if (!adminId) {
            return null;
        }
        const repo = this.connection.rawConnection.getRepository(DeliveryRide);
        const openRides = await repo.find({
            where: {
                administratorId: String(adminId),
                channelId: String(ctx.channelId),
                deliveredAt: IsNull(),
            },
            order: { startedAt: 'DESC' },
        });
        for (const ride of openRides) {
            const order = await this.getOrderById(ctx, ride.orderId);
            if (!order || order.state === 'Cancelled') {
                await repo.delete(String(ride.id));
                Logger.info(`Self-healed stale ride ${ride.id} (order ${ride.orderCode || ride.orderId} missing/cancelled)`, loggerCtx);
                continue;
            }
            if (order.state === 'Delivered') {
                ride.deliveredAt = new Date();
                await repo.save(ride);
                Logger.info(`Self-healed stale ride ${ride.id} (order ${ride.orderCode} already delivered)`, loggerCtx);
                continue;
            }
            return this.mapRide(ride); // order is live — genuine resume
        }
        return null;
    }

    // ─── Customer-facing (shop API) ───

    /**
     * What the order's OWNER may see about their delivery: whether a rider is
     * currently out with it, the rider's last known position, and a one-time
     * socket ticket bound to this order's room. Position only — never the
     * driver's identity, name, or odometer.
     *
     * Access is Vendure's own `orderByCode` rule (OrderByCodeAccessStrategy),
     * so a customer can track exactly the orders they can already open. As in
     * core, an unknown code is indistinguishable from a forbidden one.
     */
    async customerTracking(ctx: RequestContext, orderCode: string): Promise<OrderDeliveryTracking> {
        const order = await this.orderService.findOneByCode(ctx, orderCode, ['customer', 'customer.user']);
        const allowed =
            !!order &&
            (await this.configService.orderOptions.orderByCodeAccessStrategy.canAccessOrder(ctx, order));
        if (!order || !allowed) {
            throw new ForbiddenError(LogLevel.Verbose);
        }
        const orderId = String(order.id);
        const ride = await this.connection.rawConnection.getRepository(DeliveryRide).findOne({
            where: { orderId, deliveredAt: IsNull() },
            order: { startedAt: 'DESC' },
        });
        if (!ride) {
            return { active: false, lat: null, lng: null, updatedAt: null, socketTicket: null, routePolyline: null };
        }
        const status = await this.connection.rawConnection.getRepository(DriverStatus).findOne({
            where: { administratorId: ride.administratorId, channelId: ride.channelId },
        });
        // Road route rider → shipping-address pin, cached per order. Needs
        // both ends; without either, the map falls back to no line.
        let routePolyline: string | null = null;
        const dest = this.destinationOf((order as any).shippingAddress);
        if (dest && status?.lat != null && status?.lng != null) {
            const route = await this.deliveryRouteService.routeForOrder(
                orderId,
                { lat: status.lat, lng: status.lng },
                dest,
            );
            routePolyline = route?.encodedPolyline ?? null;
        }
        return {
            active: true,
            lat: status?.lat ?? null,
            lng: status?.lng ?? null,
            updatedAt: status?.lastHeartbeatAt ?? null,
            socketTicket: this.fleetGateway.issueCustomerTicket(ride.channelId, orderId),
            routePolyline,
        };
    }

    /** Shipping-address map pin from the order's embedded address (JSON column). */
    private destinationOf(shippingAddress: unknown): RoutePoint | null {
        try {
            const addr =
                typeof shippingAddress === 'string' ? JSON.parse(shippingAddress) : shippingAddress;
            const lat = Number((addr as any)?.customFields?.latitude);
            const lng = Number((addr as any)?.customFields?.longitude);
            return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        } catch {
            return null;
        }
    }

    /** Same pin, looked up by order id (driver-fix paths have no loaded order). */
    private async getOrderDestination(ctx: RequestContext, orderId: string): Promise<RoutePoint | null> {
        const row = await this.connection
            .getRepository(ctx, 'Order')
            .createQueryBuilder('o')
            .select('o.shippingAddress', 'shippingAddress')
            .where('o.id = :id', { id: orderId })
            .getRawOne();
        return row ? this.destinationOf(row.shippingAddress) : null;
    }

    // ─── Fleet-facing queries ───

    /**
     * One row per delivery person of the channel with derived state:
     * open ride ⇒ OUT_FOR_DELIVERY; fresh heartbeat with GPS on ⇒ ACTIVE;
     * silence or GPS off ⇒ INACTIVE. metersToday sums the day's rides.
     */
    async driverStatuses(ctx: RequestContext) {
        const channelId = String(ctx.channelId);
        const dps = await this.deliveryPartnerService.getDeliveryPersons(ctx);
        const [statuses, openRides, todaySums] = await Promise.all([
            this.connection.rawConnection.getRepository(DriverStatus).find({ where: { channelId } }),
            this.connection.rawConnection.getRepository(DeliveryRide).find({
                where: { channelId, deliveredAt: IsNull() },
                order: { startedAt: 'DESC' },
            }),
            this.getMetersToday(channelId),
        ]);
        const statusByAdmin = new Map(statuses.map(s => [s.administratorId, s]));
        const openRideByAdmin = new Map<string, DeliveryRide>();
        for (const ride of openRides) {
            if (!openRideByAdmin.has(ride.administratorId)) {
                openRideByAdmin.set(ride.administratorId, ride);
            }
        }
        const now = Date.now();
        return dps.map((dp: any) => {
            const status = statusByAdmin.get(String(dp.id));
            const openRide = openRideByAdmin.get(String(dp.id));
            const fresh =
                !!status?.lastHeartbeatAt &&
                now - new Date(status.lastHeartbeatAt).getTime() <= HEARTBEAT_STALE_MS;
            // GPS/presence outranks the open ride: a rider who turns GPS off
            // (or goes silent) shows INACTIVE even mid-delivery, and flips
            // back to OUT_FOR_DELIVERY automatically when fixes resume — the
            // open ride only decides WHICH live state they're in. The ride
            // itself stays open throughout (resume/km unaffected), and the
            // order id remains visible on the row either way.
            let state: DriverFleetState = 'INACTIVE';
            if (fresh && !!status?.gpsOn) {
                state = openRide ? 'OUT_FOR_DELIVERY' : 'ACTIVE';
            }
            return {
                // String, always: GraphQL coerces ID fields on the query path,
                // but this same object is ALSO pushed raw over the socket —
                // a numeric id there breaks the client's strict-equality patch.
                administratorId: String(dp.id),
                name: `${dp.firstName} ${dp.lastName}`.trim(),
                phoneNumber: dp.phoneNumber || null,
                state,
                lat: status?.lat ?? null,
                lng: status?.lng ?? null,
                gpsOn: !!status?.gpsOn,
                lastHeartbeatAt: status?.lastHeartbeatAt ?? null,
                metersToday: todaySums.get(String(dp.id)) ?? 0,
                activeOrderId: openRide?.orderId ?? null,
                activeOrderCode: openRide?.orderCode ?? null,
            };
        });
    }

    /** Ride history for one driver in a date range (fleet detail page). */
    async driverRides(ctx: RequestContext, deliveryPersonId: ID, dateFrom: Date, dateTo: Date) {
        const rides = await this.connection.rawConnection
            .getRepository(DeliveryRide)
            .createQueryBuilder('ride')
            .where('ride.administratorId = :adminId', { adminId: String(deliveryPersonId) })
            .andWhere('ride.channelId = :channelId', { channelId: String(ctx.channelId) })
            .andWhere('ride.startedAt >= :from', { from: dateFrom })
            .andWhere('ride.startedAt <= :to', { to: dateTo })
            .orderBy('ride.startedAt', 'DESC')
            .getMany();
        return rides.map(r => this.mapRide(r));
    }

    /**
     * Orders one driver held in a date range (fleet detail page): assigned by
     * the end of the range and not delivered/cancelled before its start — i.e.
     * assigned in the range, closed in the range, or still open. One row per
     * fulfillment (= one assignment) with its current state, newest first.
     */
    async driverAssignedOrders(
        ctx: RequestContext,
        deliveryPersonId: ID,
        dateFrom: Date,
        dateTo: Date,
    ): Promise<DriverAssignedOrder[]> {
        const rows = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .innerJoin('o.channels', 'ch', 'ch.id = :channelId', { channelId: ctx.channelId })
            .leftJoin('o.customer', 'c')
            .select('f.id', 'fulfillmentId')
            .addSelect('f.state', 'state')
            .addSelect('f.createdAt', 'assignedAt')
            .addSelect('f.customFieldsDeliveredat', 'deliveredAt')
            .addSelect('f.updatedAt', 'updatedAt')
            .addSelect('o.id', 'orderId')
            .addSelect('o.code', 'orderCode')
            .addSelect('o.subTotalWithTax', 'subTotalWithTax')
            .addSelect('o.shippingWithTax', 'shippingWithTax')
            .addSelect('o.shippingAddress', 'shippingAddress')
            .addSelect('c.firstName', 'customerFirstName')
            .addSelect('c.lastName', 'customerLastName')
            .where('f.customFieldsDeliverypersonid = :dpId', { dpId: String(deliveryPersonId) })
            .andWhere('f.createdAt <= :dateTo', { dateTo })
            // deliveredAt is stamped only by transitToDelivered — a delivery
            // marked from the Vendure admin UI has none until the bootstrap
            // backfill copies updatedAt, so fall back to updatedAt here too.
            .andWhere(
                new Brackets(qb => {
                    qb.where('f.state IN (:...openStates)', { openStates: OPEN_FULFILLMENT_STATES })
                        .orWhere(
                            "(f.state = 'Delivered' AND COALESCE(f.customFieldsDeliveredat, f.updatedAt) >= :dateFrom)",
                            { dateFrom },
                        )
                        .orWhere("(f.state = 'Cancelled' AND f.updatedAt >= :dateFrom)", { dateFrom });
                }),
            )
            .getRawMany();
        return toDriverAssignedOrders(rows);
    }

    // ─── Internals ───

    /**
     * Push one driver's fresh fleet status to connected viewers of the channel.
     * Cheap no-op when nobody is watching; never fails the calling mutation.
     */
    private async pushDriverUpdate(ctx: RequestContext, adminId: string): Promise<void> {
        try {
            if (!this.fleetGateway.hasViewers(String(ctx.channelId))) {
                return;
            }
            const all = await this.driverStatuses(ctx);
            const one = all.find(d => String(d.administratorId) === adminId);
            if (one) {
                this.fleetGateway.emitDriverUpdate(String(ctx.channelId), one);
            }
        } catch (e: any) {
            Logger.debug(`Fleet push skipped: ${e.message}`, loggerCtx);
        }
    }

    private async requireAdminId(ctx: RequestContext): Promise<ID> {
        const adminId = await this.deliveryPartnerService.getAdministratorIdFromUser(ctx);
        if (!adminId) {
            throw new UserInputError('No administrator found for the current user');
        }
        return adminId;
    }

    private async ensureOpenRide(
        ctx: RequestContext,
        administratorId: string,
        orderId: string,
        orderCode: string,
    ): Promise<DeliveryRide> {
        const repo = this.connection.rawConnection.getRepository(DeliveryRide);
        const existing = await repo.findOne({
            where: { administratorId, orderId, deliveredAt: IsNull() },
        });
        if (existing) {
            return existing;
        }
        const ride = await repo.save(
            new DeliveryRide({
                administratorId,
                orderId,
                orderCode,
                channelId: String(ctx.channelId),
                startedAt: new Date(),
                deliveredAt: null,
                distanceMeters: 0,
            }),
        );
        Logger.info(`Ride started: driver ${administratorId} → order ${orderCode}`, loggerCtx);
        return ride;
    }

    /**
     * Stamp deliveredAt on the open ride (keeping the max km).
     *
     * When no open ride exists, we do NOT immediately create one: the
     * fulfillment-Delivered event and the explicit completeDeliveryRide
     * mutation race each other (the event fires after commit, the client
     * calls right after the same transition), and whichever arrives second
     * used to insert a duplicate zero-km row. Now the second arrival finds
     * the just-closed ride and merges its km into it. Only when NO ride for
     * (driver, order) closed recently — a fully-offline ride where every
     * signal was missed — is a degraded closed row created for history.
     */
    private async closeOpenRide(
        ctx: RequestContext,
        administratorId: string,
        orderId: string,
        finalDistanceMeters?: number,
    ): Promise<DeliveryRide> {
        const repo = this.connection.rawConnection.getRepository(DeliveryRide);
        const open = await repo.findOne({
            where: { administratorId, orderId, deliveredAt: IsNull() },
            order: { startedAt: 'DESC' },
        });
        if (open) {
            open.deliveredAt = new Date();
            if (finalDistanceMeters != null && finalDistanceMeters > open.distanceMeters) {
                open.distanceMeters = Math.round(finalDistanceMeters);
            }
            await repo.save(open);
            Logger.info(`Ride completed: driver ${administratorId} → order ${open.orderCode} (${open.distanceMeters} m)`, loggerCtx);
            return open;
        }

        // Already closed by the other path? Merge the final km instead of
        // creating a duplicate row.
        const recentlyClosed = await repo.findOne({
            where: { administratorId, orderId },
            order: { deliveredAt: 'DESC' },
        });
        if (recentlyClosed?.deliveredAt) {
            if (
                finalDistanceMeters != null &&
                Math.round(finalDistanceMeters) > recentlyClosed.distanceMeters
            ) {
                recentlyClosed.distanceMeters = Math.round(finalDistanceMeters);
                await repo.save(recentlyClosed);
            }
            return recentlyClosed;
        }

        const order = await this.getOrderById(ctx, orderId);
        const now = new Date();
        return repo.save(
            new DeliveryRide({
                administratorId,
                orderId,
                orderCode: order?.code ?? '',
                channelId: String(ctx.channelId),
                startedAt: now,
                deliveredAt: now,
                distanceMeters: Math.max(0, Math.round(finalDistanceMeters ?? 0)),
            }),
        );
    }

    private async getMetersToday(channelId: string): Promise<Map<string, number>> {
        // "Today" is anchored to IST (the business timezone), independent of
        // the server's TZ — setHours(0,0,0,0) on a UTC production box would
        // shift the day boundary to 5:30 AM IST and misattribute morning rides.
        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const DAY_MS = 24 * 60 * 60 * 1000;
        const nowIst = Date.now() + IST_OFFSET_MS;
        const todayStart = new Date(Math.floor(nowIst / DAY_MS) * DAY_MS - IST_OFFSET_MS);
        const rows: Array<{ adminId: string; meters: string }> = await this.connection.rawConnection
            .getRepository(DeliveryRide)
            .createQueryBuilder('ride')
            .select('ride.administratorId', 'adminId')
            .addSelect('SUM(ride.distanceMeters)', 'meters')
            .where('ride.channelId = :channelId', { channelId })
            .andWhere('ride.startedAt >= :todayStart', { todayStart })
            .groupBy('ride.administratorId')
            .getRawMany();
        return new Map(rows.map(r => [String(r.adminId), Number(r.meters) || 0]));
    }

    private async getOrderById(
        ctx: RequestContext,
        orderId: ID,
    ): Promise<{ id: ID; code: string; state: string } | null> {
        const row = await this.connection
            .getRepository(ctx, 'Order')
            .createQueryBuilder('o')
            .select('o.id', 'id')
            .addSelect('o.code', 'code')
            .addSelect('o.state', 'state')
            .where('o.id = :id', { id: orderId })
            .getRawOne();
        return row ?? null;
    }

    private async getOrderFromFulfillment(
        ctx: RequestContext,
        fulfillmentId: ID,
    ): Promise<{ orderId: string; orderCode: string } | null> {
        const row = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .select('o.id', 'orderId')
            .addSelect('o.code', 'orderCode')
            .where('f.id = :id', { id: fulfillmentId })
            .limit(1)
            .getRawOne();
        return row?.orderId ? { orderId: String(row.orderId), orderCode: row.orderCode } : null;
    }

    private mapRide(ride: DeliveryRide) {
        return {
            id: ride.id,
            administratorId: ride.administratorId,
            orderId: ride.orderId,
            orderCode: ride.orderCode,
            startedAt: ride.startedAt,
            deliveredAt: ride.deliveredAt,
            distanceMeters: ride.distanceMeters,
        };
    }
}
