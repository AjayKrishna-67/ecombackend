/**
 * Indian fiscal year helpers. FY runs April 1 → March 31.
 * `getFiscalYear` returns the FY's start year: April 2026 → March 2027 is FY 2026.
 */

export function getFiscalYear(date: Date): number {
    return date.getMonth() + 1 >= 4 ? date.getFullYear() : date.getFullYear() - 1;
}

export function getFiscalYearStart(date: Date): Date {
    const fy = getFiscalYear(date);
    return new Date(Date.UTC(fy, 3, 1));
}

/**
 * Short form of the fiscal year, e.g. FY 2026 → "26-27". Used in the rendered
 * invoice number suffix: `{prefix}{n}|{fyShort}` → `M-01|26-27`.
 */
export function getFiscalYearShort(date: Date): string {
    const fy = getFiscalYear(date);
    const start = String(fy % 100).padStart(2, '0');
    const end = String((fy + 1) % 100).padStart(2, '0');
    return `${start}-${end}`;
}
