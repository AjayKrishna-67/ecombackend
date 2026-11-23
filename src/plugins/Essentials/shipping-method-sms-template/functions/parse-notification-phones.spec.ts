import { describe, expect, it } from 'vitest';

import { parseNotificationPhones } from './parse-notification-phones';

describe('parseNotificationPhones', () => {
    it('returns [] for empty / null / undefined', () => {
        expect(parseNotificationPhones(null)).toEqual([]);
        expect(parseNotificationPhones(undefined)).toEqual([]);
        expect(parseNotificationPhones('')).toEqual([]);
        expect(parseNotificationPhones('   ')).toEqual([]);
    });

    it('parses a single bare 10-digit number', () => {
        expect(parseNotificationPhones('9840012345')).toEqual(['9840012345']);
    });

    it('parses comma-separated numbers with spaces', () => {
        expect(parseNotificationPhones('9840012345, 9840067890')).toEqual(['9840012345', '9840067890']);
    });

    it('accepts semicolons and newlines as separators', () => {
        expect(parseNotificationPhones('9840012345;9840067890\n9840011111')).toEqual([
            '9840012345',
            '9840067890',
            '9840011111',
        ]);
    });

    it('strips +91, 91 and leading-0 prefixes', () => {
        expect(parseNotificationPhones('+91 98400 12345, 09840067890, 919840011111')).toEqual([
            '9840012345',
            '9840067890',
            '9840011111',
        ]);
    });

    it('strips dashes and spaces inside a number', () => {
        expect(parseNotificationPhones('98400-12345')).toEqual(['9840012345']);
    });

    it('drops entries that do not reduce to 10 digits', () => {
        expect(parseNotificationPhones('12345, 9840012345, 123456789012345')).toEqual(['9840012345']);
    });

    it('dedupes the same number typed in different formats', () => {
        expect(parseNotificationPhones('9840012345, +919840012345, 09840012345')).toEqual(['9840012345']);
    });
});
