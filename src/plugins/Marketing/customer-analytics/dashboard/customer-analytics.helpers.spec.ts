import { describe, expect, it } from 'vitest';
import {
    buildCsv,
    CSV_HEADERS,
    CsvExportRow,
    csvField,
    EXPORT_ROW_CAP,
    formatDate,
    formatDaysAgo,
    validateThresholds,
} from './customer-analytics.helpers';

// React dashboard copy of the pure helpers — same behaviour contract as the Angular
// page (the ui-devkit / dashboard build boundary prevents sharing one module).

describe('csvField — CSV-injection guard + RFC 4180', () => {
    it('returns a plain value unchanged', () => {
        expect(csvField('hello')).toBe('hello');
    });

    it('prefixes a leading = with an apostrophe (formula neutralised)', () => {
        expect(csvField('=cmd()')).toBe("'=cmd()");
    });

    it('prefixes leading + - @ and tab', () => {
        expect(csvField('+x')).toBe("'+x");
        expect(csvField('-x')).toBe("'-x");
        expect(csvField('@x')).toBe("'@x");
        expect(csvField('\tx')).toBe("'\tx");
    });

    it('preserves a leading + on phone numbers as text', () => {
        expect(csvField('+919876543210')).toBe("'+919876543210");
    });

    it('wraps and doubles inner quotes (RFC 4180)', () => {
        expect(csvField('a"b')).toBe('"a""b"');
    });

    it('wraps values containing a comma', () => {
        expect(csvField('a,b')).toBe('"a,b"');
    });

    it('wraps values containing a newline', () => {
        expect(csvField('a\nb')).toBe('"a\nb"');
    });

    it('neutralises a formula AND wraps when it also contains a comma', () => {
        expect(csvField('=a,b')).toBe('"\'=a,b"');
    });

    it('renders null and undefined as empty string', () => {
        expect(csvField(null)).toBe('');
        expect(csvField(undefined)).toBe('');
    });

    it('stringifies numbers', () => {
        expect(csvField(42)).toBe('42');
    });
});

describe('buildCsv', () => {
    const baseRow: CsvExportRow = {
        customerId: '1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        emailAddress: 'ada@example.com',
        phoneNumber: '+919999999999',
        orderCount: 3,
        totalOrderValue: 123456,
        lastOrderAt: '2026-01-15T10:30:00.000Z',
        state: 'AT_RISK',
    };

    it('starts with the exact 7-column header row', () => {
        expect(buildCsv([baseRow]).split('\r\n')[0]).toBe(CSV_HEADERS.join(','));
        expect(CSV_HEADERS).toHaveLength(7);
    });

    it('converts paise minor units to major units with 2 decimals', () => {
        expect(buildCsv([baseRow]).split('\r\n')[1]).toContain('1234.56');
    });

    it('formats last order date as ISO YYYY-MM-DD', () => {
        expect(buildCsv([baseRow]).split('\r\n')[1]).toContain('2026-01-15');
    });

    it('neutralises a phone-number leading + in the data row', () => {
        expect(buildCsv([baseRow]).split('\r\n')[1]).toContain("'+919999999999");
    });

    it('renders a missing last order date as empty', () => {
        const line = buildCsv([{ ...baseRow, lastOrderAt: null }]).split('\r\n')[1];
        expect(line.split(',')[6]).toBe('');
    });

    it('uses CRLF line endings', () => {
        expect(buildCsv([baseRow, baseRow])).toContain('\r\n');
    });
});

describe('validateThresholds — recency invariant', () => {
    it('accepts a valid pair (atRisk > active >= 0)', () => {
        expect(validateThresholds(30, 60)).toBeNull();
    });
    it('rejects NaN inputs', () => {
        expect(validateThresholds(NaN, 60)).toBe('Enter both thresholds as numbers.');
    });
    it('rejects negative inputs', () => {
        expect(validateThresholds(-1, 60)).toBe('Thresholds must be non-negative day counts.');
    });
    it('rejects atRisk equal to active', () => {
        expect(validateThresholds(30, 30)).toBe('At-Risk days must be greater than Active days.');
    });
    it('rejects atRisk less than active', () => {
        expect(validateThresholds(60, 30)).toBe('At-Risk days must be greater than Active days.');
    });
});

describe('formatDaysAgo', () => {
    it('renders null as an em dash', () => {
        expect(formatDaysAgo(null)).toBe('—');
    });
    it('renders 0 as today', () => {
        expect(formatDaysAgo(0)).toBe('today');
    });
    it('renders 1 in the singular', () => {
        expect(formatDaysAgo(1)).toBe('1 day ago');
    });
    it('renders N in the plural', () => {
        expect(formatDaysAgo(5)).toBe('5 days ago');
    });
});

describe('formatDate', () => {
    it('renders null/empty as an em dash', () => {
        expect(formatDate(null)).toBe('—');
        expect(formatDate('')).toBe('—');
    });
    it('renders a real date as a non-empty, non-dash string', () => {
        const out = formatDate('2026-01-15T10:30:00.000Z');
        expect(out).not.toBe('—');
        expect(out.length).toBeGreaterThan(0);
    });
});

describe('EXPORT_ROW_CAP', () => {
    it('matches the server export cap of 50,000', () => {
        expect(EXPORT_ROW_CAP).toBe(50_000);
    });
});
