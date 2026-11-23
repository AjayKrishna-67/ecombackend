import { Column, Entity, Index } from 'typeorm';
import { DeepPartial, VendureEntity } from '@vendure/core';

/**
 * Tracks how far an abandoned cart has progressed through the nudge sequence.
 * One row per order. `orderId`/`channelId` stored as strings to stay id-strategy-agnostic.
 * The sweep never writes to the Order, so `order.createdAt` stays a stable idle anchor.
 */
@Entity()
export class AbandonedCartNudge extends VendureEntity {
    constructor(input?: DeepPartial<AbandonedCartNudge>) {
        super(input);
    }

    @Index({ unique: true })
    @Column()
    orderId: string;

    @Column()
    channelId: string;

    @Column({ default: 0 })
    stagesSent: number;

    @Column({ type: 'datetime', nullable: true })
    lastSentAt: Date | null;
}
