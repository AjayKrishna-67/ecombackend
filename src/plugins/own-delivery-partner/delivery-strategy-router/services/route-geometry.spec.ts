import { describe, expect, it } from 'vitest';

import { decodePolyline, distanceToPathMeters } from './route-geometry';

describe('decodePolyline', () => {
    it('decodes the documented Google example', () => {
        // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
        const path = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
        expect(path).toEqual([
            { lat: 38.5, lng: -120.2 },
            { lat: 40.7, lng: -120.95 },
            { lat: 43.252, lng: -126.453 },
        ]);
    });

    it('returns an empty path for an empty string', () => {
        expect(decodePolyline('')).toEqual([]);
    });
});

describe('distanceToPathMeters', () => {
    // A ~11 km west→east segment near Madurai (lat 9.9)
    const path = [
        { lat: 9.9, lng: 78.1 },
        { lat: 9.9, lng: 78.2 },
    ];

    it('is ~zero for a point on the path', () => {
        expect(distanceToPathMeters({ lat: 9.9, lng: 78.15 }, path)).toBeLessThan(1);
    });

    it('measures perpendicular distance to the nearest segment', () => {
        // 0.0009° of latitude ≈ 100 m
        const d = distanceToPathMeters({ lat: 9.9009, lng: 78.15 }, path);
        expect(d).toBeGreaterThan(90);
        expect(d).toBeLessThan(110);
    });

    it('measures to the nearest endpoint when beyond the segment', () => {
        // 0.05° of longitude at lat 9.9 ≈ 5483 m past the east end
        const d = distanceToPathMeters({ lat: 9.9, lng: 78.25 }, path);
        expect(d).toBeGreaterThan(5400);
        expect(d).toBeLessThan(5560);
    });

    it('is Infinity for an empty path', () => {
        expect(distanceToPathMeters({ lat: 9.9, lng: 78.1 }, [])).toBe(Infinity);
    });
});
