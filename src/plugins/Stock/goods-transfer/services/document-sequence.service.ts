import { Injectable } from '@nestjs/common';
import { Channel, ID, RequestContext, TransactionalConnection, UserInputError } from '@vendure/core';

import { DocumentKind } from '../types';
import {
    buildSequenceGroupKey,
    formatDocumentNumber,
    getFiscalYearShort,
    resolveDocumentPrefix,
} from './document-number.helpers';

/**
 * Atomic document-number generator (PLAN.md §2.4) — the production-proven
 * InvoiceNumberPlugin technique, applied to transfer and damage numbers.
 *
 * Concurrency: the MySQL `LAST_INSERT_ID(expr)` upsert makes the increment
 * atomic at the SQL level, so two simultaneous confirms can NEVER receive the
 * same number — even across separate transactions.
 *
 * It runs on the RAW connection (outside the caller's transaction) — identical
 * to the invoice-number plugin. Consequence (accepted, TDS §23): if the calling
 * transaction rolls back, the consumed number becomes a gap. Gaps are fine;
 * duplicates never happen.
 */
@Injectable()
export class DocumentSequenceService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * The next number for (kind, channel, current fiscal year), plus its formatted
     * human-readable form.
     *
     * The fiscal year is inside the group key, so every sequence restarts at 1 on
     * April 1 with no scheduler — and formatDocumentNumber prints that year, so the
     * restart cannot collide with the previous year's first number.
     */
    async next(
        ctx: RequestContext,
        kind: DocumentKind,
        channelId: ID,
    ): Promise<{ value: number; formatted: string }> {
        const channel = await this.connection.getRepository(ctx, Channel).findOne({ where: { id: channelId as any } });
        if (!channel) {
            throw new UserInputError(`Channel with id ${channelId} not found for document numbering`);
        }
        const fyShort = getFiscalYearShort(new Date());
        const groupKey = buildSequenceGroupKey(kind, String(channelId), fyShort);

        // Atomic upsert-and-read on the raw connection (invoice-number pattern).
        await this.connection.rawConnection.query(
            `INSERT INTO transfer_document_sequence (groupKey, lastValue)
             VALUES (?, LAST_INSERT_ID(1))
             ON DUPLICATE KEY UPDATE lastValue = LAST_INSERT_ID(lastValue + 1)`,
            [groupKey],
        );
        const rows: Array<{ v: string | number }> = await this.connection.rawConnection.query(
            'SELECT LAST_INSERT_ID() AS v',
        );
        const value = Number(rows[0]?.v ?? 0);
        if (!value || Number.isNaN(value)) {
            // Defensive: should be impossible; never hand out a broken number.
            throw new UserInputError(`Could not allocate document number for ${groupKey}`);
        }

        // Prefix rule lives in the pure helper so it is testable without a database
        // and exists in one place — invoicePrefix when the channel has one, the
        // channel code otherwise. See resolveDocumentPrefix for why the fallback is
        // not optional.
        const customPrefix = (channel.customFields as { invoicePrefix?: string } | undefined)?.invoicePrefix;
        const prefix = resolveDocumentPrefix(customPrefix, channel.code);
        return { value, formatted: formatDocumentNumber(kind, prefix, value, fyShort) };
    }
}
