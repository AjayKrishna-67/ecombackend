// Pure, framework-agnostic helpers for the Customer Analytics page. Extracted from
// the component so the security-sensitive CSV-injection guard and the recency
// invariant are unit-testable in isolation (vitest.unit.config.mts, node env).
// Note: the React dashboard keeps its own copy — the ui-devkit build only copies
// this `ui/` folder, so it cannot import across the dashboard build boundary.

export type SegmentState = 'ACTIVE' | 'AT_RISK' | 'CHURN' | 'NEVER';

// Mirrors the server's EXPORT_CAP — when the export returns exactly this many rows the
// segment was larger and got truncated, so the toast says so instead of silently capping.
export const EXPORT_ROW_CAP = 50_000;

// Exact columns requested: id, name, phone, email, total orders, total value, last order date.
export const CSV_HEADERS: readonly string[] = [
    'Customer ID',
    'Name',
    'Phone Number',
    'Email Address',
    'Total Orders',
    'Total Order Value',
    'Last Order Date',
];

export interface CsvExportRow {
    customerId: string;
    firstName: string;
    lastName: string;
    emailAddress: string;
    phoneNumber: string | null;
    orderCount: number;
    totalOrderValue: number;
    lastOrderAt: string | null;
    state: SegmentState;
}

// Instant client-side UX guard. The server's assertValidThresholds is the authoritative
// gate (the mutation re-validates), so this only mirrors the invariant for fast feedback.
export function validateThresholds(active: number, atRisk: number): string | null {
    if (Number.isNaN(active) || Number.isNaN(atRisk)) {
        return 'Enter both thresholds as numbers.';
    }
    if (active < 0 || atRisk < 0) {
        return 'Thresholds must be non-negative day counts.';
    }
    if (atRisk <= active) {
        return 'At-Risk days must be greater than Active days.';
    }
    return null;
}

export function formatDaysAgo(days: number | null): string {
    if (days === null) {
        return '—';
    }
    if (days === 0) {
        return 'today';
    }
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function formatDate(iso: string | null): string {
    if (!iso) {
        return '—';
    }
    return new Date(iso).toLocaleDateString();
}

// Quote any field containing comma, quote, or newline; double inner quotes (RFC 4180).
// Also neutralise CSV formula injection: customer-supplied name/phone starting with
// = + - @ (or tab/CR) would execute as a formula in Excel/Sheets — prefix with ' so it
// renders as plain text (OWASP-standard mitigation; also preserves leading + on phones).
export function csvField(value: string | number | null | undefined): string {
    const raw = value === null || value === undefined ? '' : String(value);
    const str = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function buildCsv(rows: CsvExportRow[]): string {
    const lines = [CSV_HEADERS.join(',')];
    for (const row of rows) {
        const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
        // totalOrderValue is minor units (paise) → major units with 2 decimals.
        const value = (Number(row.totalOrderValue ?? 0) / 100).toFixed(2);
        // ISO YYYY-MM-DD: deterministic, sortable, locale-independent (unlike the admin's
        // browser locale) so the export re-imports cleanly into sheets and other tools.
        const lastOrder = row.lastOrderAt ? new Date(row.lastOrderAt).toISOString().slice(0, 10) : '';
        lines.push(
            [
                csvField(row.customerId),
                csvField(name),
                csvField(row.phoneNumber),
                csvField(row.emailAddress),
                csvField(row.orderCount),
                csvField(value),
                csvField(lastOrder),
            ].join(','),
        );
    }
    return lines.join('\r\n');
}
