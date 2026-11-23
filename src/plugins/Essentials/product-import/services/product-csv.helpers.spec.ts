import { describe, expect, it } from 'vitest';
import {
    buildCsvHeader,
    buildCsvLine,
    customFieldColumnKey,
    detectDuplicateSkus,
    escapeCsvField,
    EXPORT_BASE_COLUMNS,
    isExportableCustomFieldType,
    parseCsv,
    parseIntCell,
    parseTrackInventory,
    priceToMajor,
    priceToMinor,
    stringifyCustomField,
} from './product-csv.helpers';

const EXPECTED_HEADER =
    'name,variant:name,slug,description,product:hsnCode,product:productStockEnabled,product:tags,sku,price,taxCategory,stockOnHand,trackInventory,variant:shadowPrice,variant:tags';

describe('product-csv.helpers', () => {
    describe('buildCsvHeader', () => {
        it('matches the expected column order (round-trip guarantee)', () => {
            expect(buildCsvHeader()).toBe(EXPECTED_HEADER);
        });
    });

    describe('escapeCsvField', () => {
        it('leaves a plain value untouched', () => {
            expect(escapeCsvField('Apple')).toBe('Apple');
        });
        it('quotes a value containing a comma', () => {
            expect(escapeCsvField('A shirt, very soft')).toBe('"A shirt, very soft"');
        });
        it('doubles internal quotes and wraps', () => {
            expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
        });
        it('quotes a value containing a newline', () => {
            expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
        });
    });

    describe('buildCsvLine', () => {
        it('joins and escapes each field', () => {
            expect(buildCsvLine(['a', 'b,c', 'd'])).toBe('a,"b,c",d');
        });
    });

    describe('parseCsv', () => {
        // Build rows via buildCsvLine so the column count is always exactly right.
        const row = buildCsvLine([
            'Apple', '1kg', 'apple', 'A red, crisp apple', '', '', '', 'APPLE-1',
            '9.99', 'standard', '50', 'true', '', '',
        ]);
        it('keys rows by header and preserves a comma inside a quoted cell', () => {
            const rows = parseCsv(`${buildCsvHeader()}\n${row}`);
            expect(rows).toHaveLength(1);
            expect(rows[0].description).toBe('A red, crisp apple');
            expect(rows[0].sku).toBe('APPLE-1');
            expect(rows[0].price).toBe('9.99');
        });
        it('skips blank lines and handles CRLF', () => {
            const csv = `${buildCsvHeader()}\r\n\r\n${row}\r\n`;
            expect(parseCsv(csv)).toHaveLength(1);
        });
    });

    describe('priceToMinor', () => {
        it('converts major units to minor (19.99 dollars = 1999 cents)', () => {
            expect(priceToMinor('19.99')).toBe(1999);
        });
        it('rounds float drift correctly', () => {
            expect(priceToMinor('19.99')).toBe(1999); // Math.round(1998.9999...) = 1999
            expect(priceToMinor('0.10')).toBe(10);
        });
        it('returns null for an empty cell (blank = unchanged)', () => {
            expect(priceToMinor('')).toBeNull();
            expect(priceToMinor('   ')).toBeNull();
        });
        it('throws for a non-numeric value', () => {
            expect(() => priceToMinor('abc')).toThrow();
        });
    });

    describe('priceToMajor', () => {
        it('formats minor units with two decimals', () => {
            expect(priceToMajor(1998)).toBe('19.98');
            expect(priceToMajor(0)).toBe('0.00');
        });
    });

    describe('parseIntCell', () => {
        it('parses integers and treats blank as null', () => {
            expect(parseIntCell('100')).toBe(100);
            expect(parseIntCell('')).toBeNull();
        });
        it('throws on a non-integer', () => {
            expect(() => parseIntCell('1.5')).toThrow();
        });
    });

    describe('parseTrackInventory', () => {
        it('maps known flags case-insensitively', () => {
            expect(parseTrackInventory('true')).toBe('TRUE');
            expect(parseTrackInventory('FALSE')).toBe('FALSE');
            expect(parseTrackInventory('Inherit')).toBe('INHERIT');
        });
        it('returns null for empty or unknown', () => {
            expect(parseTrackInventory('')).toBeNull();
            expect(parseTrackInventory('maybe')).toBeNull();
        });
    });

    describe('detectDuplicateSkus', () => {
        it('flags only SKUs appearing more than once', () => {
            const dups = detectDuplicateSkus(['A', 'B', 'A', '', '  ']);
            expect([...dups]).toEqual(['A']);
        });
    });

    describe('customFieldColumnKey', () => {
        it('prefixes by level', () => {
            expect(customFieldColumnKey('product', 'hsnCode')).toBe('product:hsnCode');
            expect(customFieldColumnKey('variant', 'shadowPrice')).toBe('variant:shadowPrice');
        });
    });

    describe('isExportableCustomFieldType', () => {
        it('accepts scalar and locale types (all flatten to one cell)', () => {
            for (const type of ['string', 'localeString', 'localeText', 'text', 'int', 'float', 'boolean', 'datetime']) {
                expect(isExportableCustomFieldType(type)).toBe(true);
            }
        });
        it('rejects relation and struct (cannot flatten to one cell)', () => {
            expect(isExportableCustomFieldType('relation')).toBe(false);
            expect(isExportableCustomFieldType('struct')).toBe(false);
        });
    });

    describe('stringifyCustomField', () => {
        it('empty cell for null/undefined', () => {
            expect(stringifyCustomField(null, 'string')).toBe('');
            expect(stringifyCustomField(undefined, 'int')).toBe('');
        });
        it('boolean -> true/false', () => {
            expect(stringifyCustomField(true, 'boolean')).toBe('true');
            expect(stringifyCustomField(false, 'boolean')).toBe('false');
        });
        it('datetime -> ISO 8601', () => {
            expect(stringifyCustomField(new Date('2026-07-01T00:00:00.000Z'), 'datetime')).toBe(
                '2026-07-01T00:00:00.000Z',
            );
        });
        it('int/float/string -> plain string', () => {
            expect(stringifyCustomField(42, 'int')).toBe('42');
            expect(stringifyCustomField(1.5, 'float')).toBe('1.5');
            expect(stringifyCustomField('piece', 'string')).toBe('piece');
        });
        it('list custom field -> pipe-joined, each element by type', () => {
            expect(stringifyCustomField(['red', 'blue'], 'string')).toBe('red|blue');
            expect(stringifyCustomField([1, 2, 3], 'int')).toBe('1|2|3');
            expect(stringifyCustomField([], 'string')).toBe('');
        });
    });

    describe('EXPORT_BASE_COLUMNS (no-double-emit guard)', () => {
        it('contains no custom-field columns, so the dynamic pass cannot double-emit', () => {
            // hsnCode / shadowPrice / productStockEnabled are
            // owned by the dynamic custom-field pass. If any leaks into the base
            // list, the export header would repeat that column.
            const customFieldKeys = [
                'product:hsnCode',
                'product:productStockEnabled',
                'variant:shadowPrice',
            ];
            for (const key of customFieldKeys) {
                expect(EXPORT_BASE_COLUMNS).not.toContain(key);
            }
        });
    });
});
