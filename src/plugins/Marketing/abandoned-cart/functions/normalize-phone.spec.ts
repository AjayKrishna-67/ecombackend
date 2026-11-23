import { describe, it, expect } from 'vitest';
import { normalizePhone } from './normalize-phone';

describe('normalizePhone', () => {
    it('prefixes the 91 country code to a bare 10-digit number', () => {
        const actual = normalizePhone('8825767296');
        expect(actual).toBe('918825767296');
    });

    it('leaves an already 91-prefixed 12-digit number unchanged', () => {
        const actual = normalizePhone('918825767296');
        expect(actual).toBe('918825767296');
    });

    it('strips +, spaces and dashes then keeps the country code', () => {
        const actual = normalizePhone('+91 88257-67296');
        expect(actual).toBe('918825767296');
    });

    it('drops a leading zero before prefixing', () => {
        const actual = normalizePhone('08825767296');
        expect(actual).toBe('918825767296');
    });

    it('returns an empty string for empty input', () => {
        const actual = normalizePhone('');
        expect(actual).toBe('');
    });
});
