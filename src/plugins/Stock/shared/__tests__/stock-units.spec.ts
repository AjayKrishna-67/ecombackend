import { describe, expect, it } from 'vitest';
import {
    DEFAULT_STOCK_UNIT,
    STOCK_UNITS,
    formatMeasured,
    fromBase,
    toBase,
    toGrams,
    toKg,
} from '../stock-units';

describe('toBase (display -> stored base integer)', () => {
    it('scales kg to grams', () => {
        expect(toBase(1.5, 'kg')).toBe(1500);
        expect(toBase(2.5, 'kg')).toBe(2500);
    });

    it('scales litre to millilitres', () => {
        expect(toBase(0.75, 'litre')).toBe(750);
    });

    it('passes counted units through as integers', () => {
        expect(toBase(5, 'packet')).toBe(5);
        expect(toBase(12, 'piece')).toBe(12);
    });

    // A box is counted like a packet: 1 box draws 1 from a piece pool. It is
    // NOT "n pieces" -- there is no per-box piece count in the table.
    it('knows the box unit as a counted, piece-based unit', () => {
        expect(STOCK_UNITS.box).toMatchObject({ code: 'box', label: 'Boxes', baseUnit: 'piece', factor: 1, kind: 'counted' });
        expect(toBase(3, 'box')).toBe(3);
    });

    it('rounds to an integer (stockOnHand is an int column)', () => {
        expect(toBase(1.2345, 'kg')).toBe(1235);
    });

    it('falls back to the default unit for an unknown code', () => {
        expect(toBase(7, 'furlong')).toBe(7);
        expect(STOCK_UNITS[DEFAULT_STOCK_UNIT].factor).toBe(1);
    });
});

describe('fromBase (stored base -> display value)', () => {
    it('inverts toBase for kg with 3 decimals', () => {
        expect(fromBase(1500, 'kg')).toBe(1.5);
        expect(fromBase(1235, 'kg')).toBe(1.235);
    });

    it('keeps counted units whole', () => {
        expect(fromBase(5, 'packet')).toBe(5);
    });
});

describe('formatMeasured (magnitude-based display unit)', () => {
    it('shows kg at or above 1000 g, grams below', () => {
        expect(formatMeasured(1500, 'g')).toBe('1.5 kg');
        expect(formatMeasured(1000, 'g')).toBe('1 kg');
        expect(formatMeasured(500, 'g')).toBe('500 g');
        expect(formatMeasured(0, 'g')).toBe('0 g');
    });

    it('mirrors the rule for volume (litre/ml)', () => {
        expect(formatMeasured(2000, 'ml')).toBe('2 litre');
        expect(formatMeasured(750, 'ml')).toBe('750 ml');
    });

    it('renders piece-based units as a plain count', () => {
        expect(formatMeasured(12, 'piece')).toBe('12');
    });

    it('trims trailing zeros on the kg value', () => {
        expect(formatMeasured(1500, 'g')).toBe('1.5 kg');
        expect(formatMeasured(2300, 'g')).toBe('2.3 kg');
    });
});

describe('toKg / toGrams round-trip', () => {
    it('round-trips a whole kg', () => {
        expect(toKg(toGrams(3))).toBe(3);
    });

    it('handles fractional kg to grams', () => {
        expect(toGrams(0.25)).toBe(250);
        expect(toKg(250)).toBe(0.25);
    });
});
