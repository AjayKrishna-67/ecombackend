import { DocumentKind } from '../types';

/**
 * Pure, framework-free helpers for document numbering (TDS §10).
 * Extracted deliberately so they are unit-testable without a DB —
 * house pattern (see location-stock's buildStockLogRow / stock-units).
 *
 * Fiscal-year logic mirrors the production invoice-number plugin's
 * Indian FY convention (April 1 – March 31).
 */

/** FY start calendar year for a date: Apr–Dec -> same year, Jan–Mar -> previous year. */
export function getFiscalYearStartYear(date: Date): number {
    // getMonth() is 0-based: Jan=0 ... Mar=2, Apr=3
    return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
}

/** Short FY label, e.g. 2026-04-01 -> "26-27" (matches existing invoice format). */
export function getFiscalYearShort(date: Date): string {
    const start = getFiscalYearStartYear(date);
    const a = String(start % 100).padStart(2, '0');
    const b = String((start + 1) % 100).padStart(2, '0');
    return `${a}-${b}`;
}

/**
 * groupKey for the atomic sequence row: `{kind}:{channelId}:fy:{fyShort}`.
 *
 * The sequence only moves forward. A draft that is deleted keeps its number out of
 * circulation, so the series can show gaps — deliberately: reissuing a number would
 * mean two different documents had once carried it. Every gap has a DRAFT_DELETED
 * row in the audit trail explaining it.
 */
export function buildSequenceGroupKey(kind: DocumentKind, channelId: string | number, fyShort: string): string {
    return `${kind}:${channelId}:fy:${fyShort}`;
}

/** Left-pad a sequence value, e.g. 42 -> "0042". */
export function padSequence(value: number, width = 4): string {
    return String(value).padStart(width, '0');
}

/**
 * Human-readable document numbers (PLAN.md §2.4).
 *  - Transfer number : TRF-{PREFIX}-{0001}|{fy}       (e.g. TRF-MAD-0142|26-27)
 *  - Damage number   : DMG-{PREFIX}-{0001}|{fy}       (e.g. DMG-MAD-0027|26-27)
 *
 * The trailing |{fy} is load-bearing, not decoration. buildSequenceGroupKey puts the
 * fiscal year in the group key, so every sequence restarts at 1 on April 1. Without
 * the year in the printed number, the first transfer of the new year would render the
 * exact string the first transfer of the previous year already holds, and the unique
 * constraint would reject it — creation would break on April 1 and on no other day.
 * The same {value}|{fyShort} shape is what the production invoice numbers use.
 */
export function formatDocumentNumber(
    kind: DocumentKind,
    channelPrefix: string,
    value: number,
    fyShort: string,
): string {
    // Sanitize: alphanumeric only (existing invoicePrefix values may carry trailing '-')
    const prefix = ((channelPrefix || 'GT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GT');
    switch (kind) {
        case DocumentKind.TransferNumber:
            return `TRF-${prefix}-${padSequence(value)}|${fyShort}`;
        case DocumentKind.DamageNumber:
            return `DMG-${prefix}-${padSequence(value)}|${fyShort}`;
    }
}

/** Fallback prefix from a channel code when Channel.customFields.invoicePrefix is empty:
 *  "ind-madurai" -> "MADURAI" -> first 3 letters "MAD". */
export function prefixFromChannelCode(code: string): string {
    const lastSegment = (code || '').split('-').pop() || code || 'GT';
    return lastSegment.slice(0, 3).toUpperCase() || 'GT';
}

/**
 * The prefix a document number is built from (PLAN.md §2.4).
 *
 * Channel.customFields.invoicePrefix is nullable with no default, so a branch may
 * simply not have one. Falling back to the channel code matters because the code is
 * unique in core (Channel.code is @Column({ unique: true })): two branches that both
 * leave the prefix blank would otherwise produce the identical number and the second
 * branch would be unable to create anything. Uniqueness must not rest on a value a
 * human may leave empty.
 */
export function resolveDocumentPrefix(
    invoicePrefix: string | null | undefined,
    channelCode: string,
): string {
    const configured = (invoicePrefix ?? '').trim();
    return configured !== '' ? configured : prefixFromChannelCode(channelCode);
}
