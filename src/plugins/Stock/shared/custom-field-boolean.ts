/**
 * Reads a boolean custom field safely.
 *
 * MySQL has no boolean type -- Vendure stores `type: 'boolean'` custom fields
 * as `tinyint`, and depending on how the row was loaded the value arrives as
 * the NUMBER 1/0 rather than `true`/`false`. A strict `=== true` test therefore
 * silently reads every enabled flag as disabled:
 *
 *   1 === true   // false
 *
 * That single comparison is why product-level weight-pool stock never
 * allocated: `productStockEnabled` was 1 in the database for every product,
 * the strategy read it as off, and quietly fell back to per-variant stock --
 * which allowed overselling, because nothing was decrementing the pool.
 *
 * Handles the shapes a tinyint/boolean column can actually surface as:
 *   true | false          (TypeORM converted it)
 *   1 | 0                 (raw driver value)
 *   '1' | '0' | 'true'    (string, e.g. via a CSV import round-trip)
 *   null | undefined      (never set)
 *
 * Deliberately NOT `Boolean(value)`: that maps the string '0' to true, which is
 * exactly the wrong answer for a value round-tripped through a spreadsheet.
 */
export function isCustomFieldTrue(value: unknown): boolean {
    if (value === true) {
        return true;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes';
    }
    return false;
}
