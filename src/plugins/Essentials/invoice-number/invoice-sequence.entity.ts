import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Stores the last-issued invoice number for each "invoice group". A group key
 * is either `prefix:{invoicePrefix}:fy:{fy}` — every channel sharing that
 * prefix runs on this one sequence — or `channel:{channelId}:fy:{fy}` when the
 * channel has no prefix and numbers independently. The fiscal year is part of
 * the key so each FY starts a fresh row; no scheduled reset is needed.
 *
 * Reads MUST acquire a pessimistic write lock (`SELECT ... FOR UPDATE`) and
 * the increment+update MUST happen inside a transaction. Without this, two
 * concurrent OrderPlacedEvent handlers can read the same `lastValue` and
 * issue duplicate invoice numbers.
 */
@Entity()
export class InvoiceSequence {
    @PrimaryColumn({ type: 'varchar', length: 191 })
    groupKey: string;

    @Column({ type: 'bigint' })
    lastValue: number;
}
