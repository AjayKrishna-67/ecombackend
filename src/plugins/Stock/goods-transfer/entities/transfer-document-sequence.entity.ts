import { DeepPartial } from '@vendure/core';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Atomic document-number sequence (TDS §10) — a faithful clone of the
 * production-proven InvoiceNumberPlugin pattern (MySQL LAST_INSERT_ID upsert):
 * duplicates are impossible even under concurrency; gaps on rollback are
 * accepted (same tradeoff production order-invoicing already accepts).
 *
 * groupKey format: `{kind}:{channelId}:fy:{fyShort}` where kind ∈
 * DocumentKind ('transfer' | 'transfer-pdf' | 'damage-pdf') and fy is the
 * Indian fiscal year (Apr–Mar), per the existing invoice-number convention.
 *
 * Deliberately NOT a VendureEntity: the natural primary key IS the groupKey
 * (mirrors invoice-number's InvoiceSequence design).
 */
@Entity()
export class TransferDocumentSequence {
    constructor(input?: DeepPartial<TransferDocumentSequence>) {
        if (input) {
            Object.assign(this, input);
        }
    }

    @PrimaryColumn({ type: 'varchar', length: 120 })
    groupKey: string;

    /** bigint arrives from the driver as string. */
    @Column({ type: 'bigint', default: 0 })
    lastValue: string;
}
