import { Column, Entity, Index } from 'typeorm';
import { DeepPartial, VendureEntity } from '@vendure/core';
import { AbandonedCartEventType } from '../types';

/**
 * Append-only log of abandoned-cart nudge outcomes, powering analytics. One row per event:
 * a `sent` event per WhatsApp message dispatched, and a `converted` event when a nudged cart's
 * order is placed. `cartCreatedAt` is snapshotted so time-to-order survives order archival/deletion
 * without a join. `orderId`/`channelId` stored as strings to stay id-strategy-agnostic.
 */
@Entity()
export class AbandonedCartEvent extends VendureEntity {
    constructor(input?: DeepPartial<AbandonedCartEvent>) {
        super(input);
    }

    @Index()
    @Column()
    orderId: string;

    @Column()
    channelId: string;

    @Column({ type: 'varchar' })
    eventType: AbandonedCartEventType;

    @Column({ type: 'int' })
    stage: number;

    @Column({ type: 'varchar', nullable: true })
    templateName: string | null;

    // Order total (minor units) captured on `converted` events; null for `sent`. Powers revenue/ROI.
    @Column({ type: 'int', nullable: true })
    orderTotalMinor: number | null;

    @Column({ type: 'datetime' })
    cartCreatedAt: Date;

    @Column({ type: 'datetime' })
    occurredAt: Date;
}
