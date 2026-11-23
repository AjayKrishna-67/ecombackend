import { DeepPartial, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

export type PriceSyncStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * A durable work-item for the background order price sync.
 *
 * One row per order awaiting a background price recalculation (orders where a
 * customer is NOT mid-checkout — those are synced immediately, not queued). The
 * scheduled drain claims small batches of `pending` rows only when the server is
 * healthy, so a bulk product-price update can no longer recalc every order at
 * once and starve the shared DB pool.
 *
 * Idempotent: the drain recomputes real price deltas at run time, so a row whose
 * order is already correct is a cheap no-op. Unique on `orderId` — enqueue upserts
 * (re-arms an existing row back to `pending`) so there is at most one work-item
 * per order.
 */
@Entity()
@Index(['status', 'nextRunAt'])
export class PriceSyncQueueItem extends VendureEntity {
    constructor(input?: DeepPartial<PriceSyncQueueItem>) {
        super(input);
    }

    // Explicit `int` — a bare ID column has no relation to infer the type from,
    // and the ID union type erases to Object which MySQL can't map. Matches the
    // `orderId int` column in migration 1784200000000.
    @Column({ type: 'int' })
    @Index({ unique: true })
    orderId: ID;

    /**
     * The channel the triggering price update happened in. The drain MUST
     * recompute the order in this channel's context — variant prices are
     * per-channel, so recomputing under the default channel would apply the
     * wrong (master) price.
     */
    @Column()
    channelToken: string;

    // Explicit type: PriceSyncStatus is an imported alias, which per-file
    // transpilers (vitest) cannot resolve for decorator metadata. varchar is what
    // tsc infers anyway, so the schema is unchanged.
    @Column({ type: 'varchar', default: 'pending' })
    status: PriceSyncStatus;

    @Column({ default: 0 })
    attempts: number;

    @Column({ type: 'datetime', nullable: true })
    nextRunAt: Date | null;

    @Column({ type: 'datetime', nullable: true })
    claimedAt: Date | null;

    // Explicit varchar — `string | null` erases to Object in decorator metadata,
    // so a nullable string column needs its type stated (same reason as orderId).
    @Column({ type: 'varchar', nullable: true })
    claimedBy: string | null;

    @Column({ type: 'text', nullable: true })
    lastError: string | null;
}
