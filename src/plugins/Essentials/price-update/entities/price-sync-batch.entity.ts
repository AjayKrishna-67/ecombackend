import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * One row per price-update event's order-sync fan-out — the persisted form of
 * the "N variant(s) touch M active order(s) (X sync now, Y queued)" log line, so
 * the PWA Price History can show sync activity over time.
 *
 * A summary snapshot at enqueue time (not live drain progress): `queuedCount` is
 * how many were deferred, not how many still remain — live remaining is the
 * separate `pendingInQueue` count off the queue table.
 */
@Entity()
@Index(['createdAt'])
export class PriceSyncBatch extends VendureEntity {
    constructor(input?: DeepPartial<PriceSyncBatch>) {
        super(input);
    }

    @Column()
    channelToken: string;

    @Column()
    channelCode: string;

    @Column()
    variantCount: number;

    @Column()
    affectedOrders: number;

    @Column()
    syncedNow: number;

    @Column()
    queuedCount: number;
}
