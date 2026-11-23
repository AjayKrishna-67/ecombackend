import { parse } from 'csv-parse/sync';

/**
 * Single source of truth for the product CSV column order. The export resolver
 * emits this header, the template download uses it, and the update parser reads
 * by these keys — so adding a column happens in exactly one place.
 *
 * UPDATE (re-import) only WRITES the variant-grain columns: sku (match key),
 * price, taxCategory, stockOnHand, trackInventory, variant:shadowPrice.
 * The product-level / structural columns are exported for
 * reference and IGNORED on update (see product-csv.service.ts).
 */
export const CSV_COLUMNS = [
    'name',
    'variant:name',
    'slug',
    'description',
    'product:hsnCode',
    'product:productStockEnabled',
    'product:tags',
    'sku',
    'price',
    'taxCategory',
    'stockOnHand',
    'trackInventory',
    'variant:shadowPrice',
    'variant:tags',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

export type CsvRow = Record<string, string>;

/**
 * Non-custom-field columns emitted by EXPORT, in canonical order. These are the
 * translatable/base/tag columns whose values are built explicitly in
 * buildVariantLine. Custom-field columns are NOT listed here — the export appends
 * them dynamically from ConfigService so a new custom field needs no code edit.
 *
 * This is deliberately separate from CSV_COLUMNS: CSV_COLUMNS is the fixed
 * TEMPLATE + re-import contract, while export builds its column set at runtime.
 */
export const EXPORT_BASE_COLUMNS = [
    'name',
    'variant:name',
    'slug',
    'description',
    'product:tags',
    'sku',
    'price',
    'taxCategory',
    'stockOnHand',
    'trackInventory',
    'variant:tags',
] as const;

export type CustomFieldLevel = 'product' | 'variant';

/**
 * Custom-field types the export can flatten into a single CSV cell. The locale*
 * types resolve to a single string for the request language, so they're fine.
 * `relation` (points at another entity) and `struct` (nested object) can't
 * flatten to one cell, so they're excluded. `list: true` fields of an allowed
 * type ARE exportable — stringifyCustomField joins their values with `|`.
 */
const EXPORTABLE_CUSTOM_FIELD_TYPES = new Set([
    'string',
    'localeString',
    'localeText',
    'text',
    'int',
    'float',
    'boolean',
    'datetime',
]);

export function isExportableCustomFieldType(type: string): boolean {
    return EXPORTABLE_CUSTOM_FIELD_TYPES.has(type);
}

/**
 * Build the CSV column key for a custom field: `product:hsnCode`,
 * `variant:shadowPrice`. One place owns the level prefix so the header, the row
 * builder, and any future re-import can never drift apart.
 */
export function customFieldColumnKey(level: CustomFieldLevel, name: string): string {
    return `${level}:${name}`;
}

/**
 * Stringify one custom-field value for a CSV cell by its Vendure type. Null /
 * undefined -> empty cell. boolean -> true/false (matches trackInventory).
 * datetime -> ISO 8601. Everything else -> plain string. Locked contract so a
 * future re-import can parse these back without a breaking format change.
 */
export function stringifyCustomField(value: unknown, type: string): string {
    if (value === null || value === undefined) {
        return '';
    }
    // list custom fields arrive as arrays -> join with `|` (same as tags), each
    // element stringified by the field's element type.
    if (Array.isArray(value)) {
        return value.map(item => stringifyCustomField(item, type)).join('|');
    }
    if (type === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (type === 'datetime') {
        return value instanceof Date ? value.toISOString() : String(value);
    }
    return String(value);
}

/**
 * Quote a single CSV field per RFC 4180: wrap in double quotes and double any
 * internal quote, but only when the value actually contains a comma, quote, or
 * newline. Without this, a product description containing a comma shifts every
 * later column on re-import.
 */
export function escapeCsvField(value: string): string {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

export function buildCsvLine(values: string[]): string {
    return values.map(escapeCsvField).join(',');
}

export function buildCsvHeader(): string {
    return buildCsvLine([...CSV_COLUMNS]);
}

/**
 * Sample rows for the downloadable template, in CSV_COLUMNS order. Kept here so
 * the template and the export share the one column definition.
 */
const TEMPLATE_SAMPLE_ROWS: string[][] = [
    // name, variant:name, slug, description, product:hsnCode,
    // product:productStockEnabled, product:tags, sku, price, taxCategory,
    // stockOnHand, trackInventory, variant:shadowPrice, variant:tags
    [
        'Example T-Shirt', 'Small', 'example-t-shirt', 'A comfortable cotton t-shirt',
        '1234', '0', 'apparel|cotton', 'TSHIRT-S', '19.99', 'standard',
        '100', 'true', '2499', 'summer',
    ],
    [
        '', 'Medium', '', '', '', '', '', 'TSHIRT-M', '19.99', 'standard',
        '80', 'true', '2499', '',
    ],
];

export function buildTemplateCsv(): string {
    return [buildCsvHeader(), ...TEMPLATE_SAMPLE_ROWS.map(buildCsvLine)].join('\n') + '\n';
}

/**
 * Parse a CSV string into header-keyed rows using a battle-tested parser, so
 * quoted commas / newlines inside cells are handled correctly.
 */
export function parseCsv(input: string): CsvRow[] {
    return parse(input, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
    }) as CsvRow[];
}

/**
 * Major-units string ("19.99") -> minor units (1998). Returns null for an
 * empty cell (blank = leave unchanged) and throws for a non-numeric value so
 * the caller can report a per-row error. Math.round guards float drift
 * (19.99 * 100 = 1998.9999...).
 */
export function priceToMinor(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === '') {
        return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
        throw new Error(`invalid price "${value}"`);
    }
    return Math.round(parsed * 100);
}

/** Minor units (1998) -> major-units string ("19.98") for export. */
export function priceToMajor(minor: number): string {
    return (minor / 100).toFixed(2);
}

/**
 * Parse an integer cell (stockOnHand, shadowPrice). Empty -> null
 * (skip), non-integer -> throw for a per-row error.
 */
export function parseIntCell(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === '') {
        return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) {
        throw new Error(`invalid integer "${value}"`);
    }
    return parsed;
}

/**
 * Map a trackInventory cell to a Vendure GlobalFlag value. Accepts
 * true/false/inherit case-insensitively; empty or unknown -> null (skip).
 */
export function parseTrackInventory(value: string): 'TRUE' | 'FALSE' | 'INHERIT' | null {
    const v = value.trim().toUpperCase();
    if (v === 'TRUE' || v === 'FALSE' || v === 'INHERIT') {
        return v;
    }
    return null;
}

/**
 * Find SKUs that appear more than once across the file. Re-importing the same
 * SKU twice would otherwise double-apply silently.
 */
export function detectDuplicateSkus(skus: string[]): Set<string> {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const raw of skus) {
        const sku = raw.trim();
        if (sku === '') {
            continue;
        }
        if (seen.has(sku)) {
            duplicates.add(sku);
        }
        seen.add(sku);
    }
    return duplicates;
}
