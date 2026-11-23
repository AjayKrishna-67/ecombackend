import { Injectable } from '@nestjs/common';
import { Channel, Logger, Order, RequestContext, TransactionalConnection } from '@vendure/core';

import { getFiscalYear, getFiscalYearShort, getFiscalYearStart } from './fiscal-year';
import { InvoiceSequence } from './invoice-sequence.entity';

const loggerCtx = 'InvoiceNumberService';
const SEQUENCE_PAD_MIN = 2;
const MAX_ASSIGN_ATTEMPTS = 3;

/**
 * True when the driver rejected a write because it collided with a unique
 * index. MySQL reports this as errno 1062 / `ER_DUP_ENTRY`; the error object
 * shape is not typed by TypeORM, hence the defensive reads.
 */
function isDuplicateKeyError(err: unknown): boolean {
    const { code, errno } = (err ?? {}) as { code?: string; errno?: number };
    return code === 'ER_DUP_ENTRY' || errno === 1062;
}

@Injectable()
export class InvoiceNumberService {
    constructor(private readonly connection: TransactionalConnection) {}

    /**
     * Atomically assigns the next sequential invoice number to the given order.
     *
     * Channels that share the same non-empty `invoicePrefix` share ONE
     * sequence per fiscal year, so a city split into delivery zones keeps a
     * single continuous invoice run. A channel with no prefix numbers
     * independently. The
     * invoice format is `{prefix}{number}|{fyShort}` e.g. M-01|26-27,
     * M-02|26-27, ... M-100|26-27. The number is zero-padded to a minimum of
     * 2 digits. The prefix is read from the channel's `invoicePrefix` custom
     * field; if unset, just `{number}|{fyShort}` is used. The short fiscal
     * year is auto-suffixed so the prefix never has to be manually edited
     * each April.
     *
     * Concurrency: the order row is pessimistic-locked at the top of the
     * transaction, so the idempotency check, sequence increment, and order
     * update all see a consistent view. A second concurrent caller blocks on
     * the lock, then reads the already-assigned invoice number and exits
     * without incrementing the sequence — no burned numbers.
     *
     * Collision recovery: the invoice number column carries a unique index, so
     * a number that is somehow already in use is rejected by the database
     * rather than silently duplicated. The usual cause is a hand-edited
     * sequence row — `lastValue` is trusted blindly when the row exists, so
     * setting it at or below the highest issued number makes every following
     * order collide. On a rejection the sequence is healed back up to the
     * highest number actually issued and the assignment is retried.
     */
    async assignInvoiceNumber(ctx: RequestContext, orderId: number): Promise<void> {
        const { prefix, groupKey, channelIds } = await this.resolveChannelConfig(ctx);
        await this.connection.withTransaction(ctx, async txCtx => {
            const existing = await this.lockOrderAndReadInvoice(txCtx, orderId);
            if (existing) {
                Logger.debug(`Order ${orderId} already has invoice ${existing}; skipping`, loggerCtx);
                return;
            }
            const fyShort = getFiscalYearShort(new Date());
            for (let attempt = 1; attempt <= MAX_ASSIGN_ATTEMPTS; attempt++) {
                const nextNumber = await this.incrementSequence(txCtx, groupKey, channelIds);
                const paddedNumber = String(nextNumber).padStart(SEQUENCE_PAD_MIN, '0');
                const invoiceNo = `${prefix}${paddedNumber}|${fyShort}`;
                try {
                    await this.writeInvoiceNumber(txCtx, orderId, invoiceNo);
                    Logger.info(
                        `Assigned invoice ${invoiceNo} to order ${orderId} (sequence: ${groupKey})`,
                        loggerCtx,
                    );
                    return;
                } catch (err) {
                    if (!isDuplicateKeyError(err) || attempt === MAX_ASSIGN_ATTEMPTS) {
                        throw err;
                    }
                    Logger.warn(
                        `Invoice ${invoiceNo} is already in use (sequence ${groupKey} is behind the ` +
                            `issued numbers, usually from a manual edit); healing and retrying`,
                        loggerCtx,
                    );
                    await this.healSequence(txCtx, groupKey, channelIds);
                }
            }
        });
    }

    /**
     * Takes the pessimistic write lock on the order row and returns its
     * current invoice number, or `null` when it has none yet. Holding this
     * lock for the rest of the transaction is what makes a second concurrent
     * caller for the same order wait and then exit as a no-op.
     */
    private async lockOrderAndReadInvoice(
        ctx: RequestContext,
        orderId: number,
    ): Promise<string | null> {
        const row = await this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('o')
            .setLock('pessimistic_write')
            .select('o.customFields.invoiceNo', 'invoiceNo')
            .where('o.id = :id', { id: orderId })
            .getRawOne();
        return row?.invoiceNo ?? null;
    }

    /**
     * Writes the invoice number onto the order. Throws when the unique index
     * rejects it (caller retries) or when no row was updated at all.
     */
    private async writeInvoiceNumber(
        ctx: RequestContext,
        orderId: number,
        invoiceNo: string,
    ): Promise<void> {
        const updateResult = await this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder()
            .update(Order)
            .set({ customFields: { invoiceNo } } as any)
            .where('id = :id', { id: orderId })
            .execute();
        if (!updateResult.affected) {
            throw new Error(
                `Assigned invoice ${invoiceNo} to order ${orderId} but UPDATE affected 0 rows`,
            );
        }
    }

    /**
     * Drags the sequence back up to the highest invoice number actually issued
     * in this fiscal year, so the next increment lands on a free number. Only
     * ever moves the counter forward — the `lastValue < :seed` guard means a
     * healthy sequence, or a concurrent caller that already healed it, is left
     * untouched.
     */
    private async healSequence(
        ctx: RequestContext,
        groupKey: string,
        channelIds: number[],
    ): Promise<void> {
        const seedValue = await this.computeSeedValue(ctx, channelIds);
        await this.connection
            .getRepository(ctx, InvoiceSequence)
            .createQueryBuilder()
            .update(InvoiceSequence)
            .set({ lastValue: seedValue })
            .where('groupKey = :key', { key: groupKey })
            .andWhere('lastValue < :seed', { seed: seedValue })
            .execute();
    }

    /**
     * Atomically increments the per-FY sequence and returns the new value.
     * Seeds the row on first use of a fiscal year by reading the highest
     * existing numeric invoice for orders placed since the FY start.
     */
    private async incrementSequence(
        ctx: RequestContext,
        groupKey: string,
        channelIds: number[],
    ): Promise<number> {
        const existing = await this.lockAndIncrement(ctx, groupKey);
        if (existing !== null) {
            return existing;
        }
        const seedValue = await this.computeSeedValue(ctx, channelIds);
        const initialValue = seedValue + 1;
        try {
            await this.connection
                .getRepository(ctx, InvoiceSequence)
                .insert({ groupKey, lastValue: initialValue });
            return initialValue;
        } catch {
            // Another caller seeded the same key first; its row is committed
            // (or we block on its lock), so a plain locked increment is correct.
            const retry = await this.lockAndIncrement(ctx, groupKey);
            if (retry === null) {
                throw new Error(`Failed to assign invoice number for channel ${groupKey}`);
            }
            return retry;
        }
    }

    /**
     * Locks the sequence row, bumps it by one and returns the new value, or
     * `null` when the row does not exist yet.
     *
     * The number is computed in-process from the locked row rather than read
     * back from the connection afterwards. The previous implementation issued
     * `UPDATE ... LAST_INSERT_ID(lastValue + 1)` and then a separate
     * `SELECT LAST_INSERT_ID()`: that value lives in MySQL *session* state, so
     * the two statements are only consistent while they share one physical
     * connection. Under a pool that is not guaranteed, and when it broke, two
     * orders were told the same number while the counter itself advanced
     * correctly — one duplicate and one burned number (live incident: two
     * orders on C-1996 with C-1997 issued to nobody).
     *
     * `SELECT ... FOR UPDATE` serialises concurrent callers on the sequence
     * row for the rest of the transaction, and the value never leaves this
     * process, so no connection can hand us someone else's number. Callers
     * take the order-row lock first and this one second — always in that
     * order, so the two locks cannot deadlock against each other.
     */
    private async lockAndIncrement(ctx: RequestContext, groupKey: string): Promise<number | null> {
        const seqRepo = this.connection.getRepository(ctx, InvoiceSequence);
        const row = await seqRepo
            .createQueryBuilder('s')
            .setLock('pessimistic_write')
            .where('s.groupKey = :key', { key: groupKey })
            .getOne();
        if (!row) {
            return null;
        }
        // `lastValue` is a bigint column, which the MySQL driver returns as a
        // string — coerce before adding or `1996 + 1` becomes '19961'.
        const nextValue = Number(row.lastValue) + 1;
        await seqRepo
            .createQueryBuilder()
            .update(InvoiceSequence)
            .set({ lastValue: nextValue })
            .where('groupKey = :key', { key: groupKey })
            .execute();
        return nextValue;
    }

    /**
     * Read the channel's invoice prefix and build the sequence group key.
     * The key embeds the current fiscal year so the sequence auto-resets
     * on April 1 — no scheduler needed. Indian FY: April 1 → March 31.
     *
     * The prefix IS the group. Every channel carrying the same non-empty
     * `invoicePrefix` shares one sequence, so a city split into delivery zones
     * keeps a single continuous run. The returned `channelIds` covers the
     * whole group — the seed scan MUST span all of them, otherwise the first
     * order after a zone is added reseeds from that zone's own (empty) history
     * and re-issues numbers the sibling zone already used.
     *
     * An empty/unset prefix is NOT a group: those channels each fall back to
     * their own `channel:{id}` key, so unrelated prefix-less channels never
     * get merged into one sequence.
     */
    private async resolveChannelConfig(
        ctx: RequestContext,
    ): Promise<{ prefix: string; groupKey: string; channelIds: number[] }> {
        const channelRepo = this.connection.getRepository(ctx, Channel);
        const channel = await channelRepo.findOne({ where: { id: ctx.channelId } });
        const prefix = (((channel?.customFields as any)?.invoicePrefix as string) || '').trim();
        const fy = getFiscalYear(new Date());
        if (!prefix) {
            return {
                prefix,
                groupKey: `channel:${ctx.channelId}:fy:${fy}`,
                channelIds: [Number(ctx.channelId)],
            };
        }
        // Load-all-then-filter rather than a `where` on the embedded
        // customFields column: the channel table holds a handful of rows, and
        // this keeps the group match free of ORM embedded-column quirks.
        const allChannels = await channelRepo.find();
        const groupChannelIds = allChannels
            .filter(c => (((c.customFields as any)?.invoicePrefix as string) || '').trim() === prefix)
            .map(c => Number(c.id));
        const channelIds = groupChannelIds.length ? groupChannelIds : [Number(ctx.channelId)];
        return { prefix, groupKey: `prefix:${prefix}:fy:${fy}`, channelIds };
    }

    /**
     * Compute the starting value for a new per-FY sequence by finding the
     * highest existing numeric invoice number among orders placed in the
     * current fiscal year across every channel in the sequence's group.
     * Pre-FY invoices are ignored so the sequence starts fresh each April 1.
     */
    private async computeSeedValue(ctx: RequestContext, channelIds: number[]): Promise<number> {
        const fyStart = getFiscalYearStart(new Date());
        const result = await this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('o')
            .innerJoin('o.channels', 'ch')
            .where('ch.id IN (:...channelIds)', { channelIds })
            .andWhere('o.customFields.invoiceNo IS NOT NULL')
            .andWhere('o.orderPlacedAt >= :fyStart', { fyStart })
            // New format `{prefix}{n}|{fyShort}` puts the sequence number
            // before the `|` — take everything up to the pipe, then read the
            // trailing digits. SUBSTRING_INDEX returns the whole string when
            // no `|` is present, so legacy formats `{prefix}{n}` and
            // `{prefix}{fy}-{n}` still fall back to their trailing digits.
            .select(
                "MAX(CAST(REGEXP_SUBSTR(SUBSTRING_INDEX(o.customFields.invoiceNo, '|', 1), '[0-9]+$') AS UNSIGNED))",
                'maxNum',
            )
            .getRawOne();
        return Number(result?.maxNum) || 0;
    }
}
