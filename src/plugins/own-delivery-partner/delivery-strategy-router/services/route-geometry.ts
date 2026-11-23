/**
 * Pure geometry helpers for delivery routes. No I/O, no Vendure — kept
 * separate so they can be unit-tested and reasoned about in isolation.
 */

export interface RoutePoint {
    lat: number;
    lng: number;
}

/**
 * Decode a Google encoded polyline (5-decimal precision) into points.
 * Algorithm: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): RoutePoint[] {
    const points: RoutePoint[] = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    while (index < encoded.length) {
        for (const which of ['lat', 'lng'] as const) {
            let result = 0;
            let shift = 0;
            let byte = 0x20;
            while (byte >= 0x20) {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            }
            const delta = result & 1 ? ~(result >> 1) : result >> 1;
            if (which === 'lat') lat += delta;
            else lng += delta;
        }
        points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
}

const EARTH_METERS_PER_DEG_LAT = 111_320;

/**
 * Shortest distance in meters from a point to a polyline path.
 *
 * Uses an equirectangular projection around the point's latitude — for the
 * few-km scales of a delivery route the error is negligible, and it keeps
 * the math to simple 2-D segment projection (the same approach the driver
 * PWA uses to snap fixes to its route).
 */
export function distanceToPathMeters(point: RoutePoint, path: RoutePoint[]): number {
    if (path.length === 0) return Infinity;
    const metersPerDegLng = EARTH_METERS_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180);
    const toXY = (p: RoutePoint): [number, number] => [
        p.lng * metersPerDegLng,
        p.lat * EARTH_METERS_PER_DEG_LAT,
    ];
    const [px, py] = toXY(point);
    let best = Infinity;
    let [ax, ay] = toXY(path[0]);
    for (let i = 0; i < path.length; i++) {
        const [bx, by] = i === 0 ? [ax, ay] : toXY(path[i]);
        if (i > 0) {
            const dx = bx - ax;
            const dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
            const cx = ax + t * dx;
            const cy = ay + t * dy;
            best = Math.min(best, Math.hypot(px - cx, py - cy));
            ax = bx;
            ay = by;
        } else {
            best = Math.min(best, Math.hypot(px - ax, py - ay));
        }
    }
    return best;
}
