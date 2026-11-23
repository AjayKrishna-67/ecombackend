import { describe, it, expect } from 'vitest';
import { isInternationalRegion, isInternationalType, typeMatchesRegion, decideAvailability } from './availability';

describe('isInternationalType', () => {
    it('matches only the International type, case/space-insensitive', () => {
        expect(isInternationalType('International')).toBe(true);
        expect(isInternationalType('INTERNATIONAL')).toBe(true);
        expect(isInternationalType('  international  ')).toBe(true);
    });

    it('is false for domestic / city / brand types and empties', () => {
        expect(isInternationalType('India')).toBe(false);
        expect(isInternationalType('CITY')).toBe(false);
        expect(isInternationalType('BRAND')).toBe(false);
        expect(isInternationalType('')).toBe(false);
        expect(isInternationalType(undefined)).toBe(false);
        expect(isInternationalType(null)).toBe(false);
    });
});

describe('isInternationalRegion', () => {
    it('treats absent country as domestic', () => {
        expect(isInternationalRegion(undefined)).toBe(false);
        expect(isInternationalRegion('')).toBe(false);
    });

    it('treats IN (any case / spacing) as domestic', () => {
        expect(isInternationalRegion('IN')).toBe(false);
        expect(isInternationalRegion('in')).toBe(false);
        expect(isInternationalRegion('  IN  ')).toBe(false);
    });

    it('treats every other country as international', () => {
        expect(isInternationalRegion('US')).toBe(true);
        expect(isInternationalRegion('ID')).toBe(true); // Indonesia, not India
        expect(isInternationalRegion('gb')).toBe(true);
    });
});

describe('typeMatchesRegion', () => {
    it('inside India keeps every non-International type', () => {
        expect(typeMatchesRegion('India', 'IN')).toBe(true);
        expect(typeMatchesRegion('CITY', 'IN')).toBe(true);
        expect(typeMatchesRegion('BRAND', 'IN')).toBe(true);
        expect(typeMatchesRegion('India', undefined)).toBe(true); // absent = domestic
    });

    it('inside India drops International channels', () => {
        expect(typeMatchesRegion('International', 'IN')).toBe(false);
        expect(typeMatchesRegion('international', 'IN')).toBe(false); // case-insensitive
    });

    it('outside India keeps ONLY International channels', () => {
        expect(typeMatchesRegion('International', 'US')).toBe(true);
        expect(typeMatchesRegion('India', 'US')).toBe(false);
        expect(typeMatchesRegion('CITY', 'ID')).toBe(false);
    });

    it('handles null/undefined type as non-International', () => {
        expect(typeMatchesRegion(null, 'IN')).toBe(true);
        expect(typeMatchesRegion(undefined, 'US')).toBe(false);
    });
});

describe('decideAvailability', () => {
    it('OPENING_SOON locks regardless of pincode (no token)', () => {
        const d = decideAvailability({ channelType: 'CITY', launchStatus: 'OPENING_SOON', postalCodeAvailable: true });
        expect(d).toEqual({ isAvailable: false, message: 'Opening soon', hasToken: false });
    });

    it('LAUNCHED + pincode serves → available with token', () => {
        const d = decideAvailability({ channelType: 'CITY', launchStatus: 'LAUNCHED', postalCodeAvailable: true });
        expect(d).toEqual({ isAvailable: true, message: undefined, hasToken: true });
    });

    it('LAUNCHED CITY + pincode not served → listed "Available", KEEPS token', () => {
        const d = decideAvailability({ channelType: 'CITY', launchStatus: 'LAUNCHED', postalCodeAvailable: false });
        expect(d).toEqual({ isAvailable: false, message: 'Available', hasToken: true });
    });

    it('LAUNCHED non-CITY + pincode not served → "Brand will available soon", DROPS token', () => {
        const brand = decideAvailability({ channelType: 'BRAND', launchStatus: 'LAUNCHED', postalCodeAvailable: false });
        expect(brand).toEqual({ isAvailable: false, message: 'Brand will available soon', hasToken: false });
        const intl = decideAvailability({ channelType: 'International', launchStatus: 'LAUNCHED', postalCodeAvailable: false });
        expect(intl.hasToken).toBe(false);
    });
});
