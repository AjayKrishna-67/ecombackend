import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

import { NotificationRefType, TransferNotificationType } from '../types';

/**
 * In-app (bell) notification, channel-scoped (TDS §17, BRS §8).
 *
 * - Written INSIDE the business transaction of the action it announces, so a
 *   notification can never exist for a rolled-back action.
 * - Deep link: refType + refId → the PWA opens the corresponding document
 *   directly (transfer detail / damage request).
 * - Retention: the list shows the latest 100 within 30 days (see constants.ts);
 *   rows are NEVER deleted.
 *
 * The document numbers and product name are SNAPSHOTTED here rather than joined
 * at read time: a notification has to stay readable on its own, and an expiry
 * warning in particular is about a product the branch may also stock locally, so
 * it names the product without needing a transfer at all.
 */
@Entity()
// Alerts are read by channel and by time — "what has this branch been told since X".
// There is no read/unread: the client remembers the last alert it showed, so the
// server holds no per-user state and there is nothing to index it by.
@Index(['recipientChannelId', 'createdAt'])
export class TransferNotification extends VendureEntity {
    constructor(input?: DeepPartial<TransferNotification>) {
        super(input);
    }

    /** The channel whose users see this notification (BR-03 scoping). */
    @EntityId()
    recipientChannelId: ID;

    @Column('varchar')
    type: TransferNotificationType;

    /** Display title, e.g. "New transfer invoice from Madurai". */
    @Column()
    title: string;

    /** Deep-link target: 'transfer' | 'damage'. */
    @Column('varchar')
    refType: NotificationRefType;

    @EntityId()
    refId: ID;

    /** Snapshot — present on every transfer/damage notification. */
    @Column('varchar', { nullable: true })
    transferNumber: string | null;

    /** Set on expiry warnings, which are about ONE product. */
    @Column('varchar', { nullable: true })
    productName: string | null;

    /** Expiry warnings only: when this stock reaches the end of its shelf life. */
    @Column({ type: 'datetime', nullable: true })
    expiresAt: Date | null;

    /**
     * Name of the admin whose action raised this (snapshot — survives renames).
     * Column keeps its original name so existing rows are not lost.
     */
    @Column('varchar', { name: 'actorName', default: '' })
    userName: string;
}
