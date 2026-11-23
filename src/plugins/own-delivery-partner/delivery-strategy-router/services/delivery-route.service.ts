import { Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';

import { FleetGateway } from '../api/fleet.gateway';
import { decodePolyline, distanceToPathMeters, RoutePoint } from './route-geometry';

const loggerCtx = 'DeliveryRouteService';

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/** Required by the Routes API; also pins billing to the cheapest SKU tier. */
const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline';

/** Driver further than this from the cached line ⇒ they rerouted. Mirrors the driver PWA. */
const OFF_ROUTE_METERS = 60;
/** At most one Google call per order per this window — reroute or not. */
const MIN_RECOMPUTE_MS = 20 * 1000;
/** A Google call that hangs must never stall tracking. */
const FETCH_TIMEOUT_MS = 5 * 1000;

export interface ComputedRoute {
    encodedPolyline: string;
    distanceMeters: number;
    durationSeconds: number;
}

interface CachedRoute {
    route: ComputedRoute;
    /** Decoded once so off-route checks are pure math, no re-decoding. */
    path: RoutePoint[];
    computedAt: number;
}

/**
 * Road routes (driver → customer) for the live-tracking map, via the Google
 * Routes API — the same source the driver PWA draws its line from, so the
 * customer sees the same road-following polyline as the delivery person.
 *
 * Google calls are aggressively bounded:
 *  - one cached route per order, reused while the driver stays ON the line;
 *  - recomputed only when the driver strays > OFF_ROUTE_METERS, at most once
 *    per MIN_RECOMPUTE_MS (failure also arms the throttle — no hammering);
 *  - the driver-fix path computes only while a customer is actually watching.
 *
 * Recomputes are pushed to the order's room as `delivery-route`, so a driver
 * taking a different street updates the customer's line live.
 */
@Injectable()
export class DeliveryRouteService {
    constructor(private fleetGateway: FleetGateway) {}

    private cache = new Map<string, CachedRoute>();
    /** Last compute ATTEMPT per order (success or failure) — the throttle. */
    private lastAttemptAt = new Map<string, number>();

    /**
     * Route for the tracking query: cached while the driver is on it,
     * recomputed (throttle-permitting) when they are not. Null when routing
     * is unconfigured/unavailable — tracking still works without the line.
     */
    async routeForOrder(orderId: string, driver: RoutePoint, destination: RoutePoint): Promise<ComputedRoute | null> {
        const cached = this.cache.get(orderId);
        if (cached && distanceToPathMeters(driver, cached.path) <= OFF_ROUTE_METERS) {
            return cached.route;
        }
        if (this.throttled(orderId)) {
            return cached?.route ?? null; // stale beats nothing; never hammer Google
        }
        return this.computeAndCache(orderId, driver, destination);
    }

    /**
     * Driver-fix hook: keep watching customers' lines truthful. No watchers ⇒
     * free. On the cached line ⇒ free. Off it ⇒ one recompute per window,
     * pushed to the room.
     */
    async maybeRefreshRoute(orderId: string, driver: RoutePoint, destination: RoutePoint): Promise<void> {
        if (!this.fleetGateway.hasOrderWatchers(orderId)) {
            return;
        }
        const cached = this.cache.get(orderId);
        if (cached && distanceToPathMeters(driver, cached.path) <= OFF_ROUTE_METERS) {
            return;
        }
        if (this.throttled(orderId)) {
            return;
        }
        const route = await this.computeAndCache(orderId, driver, destination);
        if (route) {
            this.fleetGateway.emitDeliveryRoute(orderId, {
                encodedPolyline: route.encodedPolyline,
                at: Date.now(),
            });
        }
    }

    /** Delivery over — forget the order. */
    clear(orderId: string): void {
        this.cache.delete(orderId);
        this.lastAttemptAt.delete(orderId);
    }

    private throttled(orderId: string): boolean {
        const last = this.lastAttemptAt.get(orderId) ?? 0;
        return Date.now() - last < MIN_RECOMPUTE_MS;
    }

    private async computeAndCache(
        orderId: string,
        driver: RoutePoint,
        destination: RoutePoint,
    ): Promise<ComputedRoute | null> {
        this.lastAttemptAt.set(orderId, Date.now());
        const route = await this.fetchRoute(driver, destination);
        if (!route) {
            return null;
        }
        this.cache.set(orderId, {
            route,
            path: decodePolyline(route.encodedPolyline),
            computedAt: Date.now(),
        });
        return route;
    }

    /** One computeRoutes call — the same request shape as the driver PWA's proxy. */
    private async fetchRoute(origin: RoutePoint, destination: RoutePoint): Promise<ComputedRoute | null> {
        const key = process.env.GOOGLE_MAPS_SERVER_KEY || process.env.GOOGLE_MAPS_API_KEY;
        if (!key) {
            return null;
        }
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            const res = await fetch(ROUTES_URL, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': key,
                    'X-Goog-FieldMask': FIELD_MASK,
                    // The shared key is referrer-restricted (browser key); a
                    // server request sends no referer and would be rejected.
                    // Present an allowed origin, same trick as the PWA proxy.
                    ...(process.env.GOOGLE_MAPS_KEY_REFERER
                        ? { Referer: process.env.GOOGLE_MAPS_KEY_REFERER }
                        : {}),
                },
                body: JSON.stringify({
                    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
                    destination: {
                        location: { latLng: { latitude: destination.lat, longitude: destination.lng } },
                    },
                    travelMode: 'DRIVE',
                    routingPreference: 'TRAFFIC_AWARE',
                }),
            }).finally(() => clearTimeout(timer));
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                Logger.warn(`Routes API error ${res.status}: ${detail.slice(0, 200)}`, loggerCtx);
                return null;
            }
            const data = (await res.json()) as {
                routes?: Array<{
                    distanceMeters?: number;
                    duration?: string; // "600s"
                    polyline?: { encodedPolyline?: string };
                }>;
            };
            const route = data.routes?.[0];
            if (!route?.polyline?.encodedPolyline) {
                return null;
            }
            return {
                encodedPolyline: route.polyline.encodedPolyline,
                distanceMeters: route.distanceMeters ?? 0,
                durationSeconds: parseInt(route.duration ?? '0', 10) || 0,
            };
        } catch (e: any) {
            Logger.debug(`Route fetch failed: ${e.message}`, loggerCtx);
            return null;
        }
    }
}
