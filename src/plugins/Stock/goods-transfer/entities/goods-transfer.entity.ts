import { Channel, ChannelAware, DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinTable, ManyToMany, OneToMany } from 'typeorm';

import { TransferState } from '../types';
import { GoodsTransferLine } from './goods-transfer-line.entity';

/**
 * The Goods Transfer aggregate root (TDS §4, BRS §4-5).
 *
 * State machine (forward-only, GT-06): DRAFT -> CONFIRMED -> DISPATCHED -> RECEIVED.
 *
 * - sourceChannelId is fixed at creation from ctx.channelId — the creator's own
 *   channel, never taken from input (GT-01).
 * - destinationChannelId is CHOSEN by the user from the Ship-To dropdown and
 *   validated server-side: not the source, not the default channel (GT-04).
 * - Only the DESTINATION StockLocation is pinned, at Confirm. There is no source
 *   location, because source stock is never touched (GT-01).
 * - Name snapshots (createdByName etc.) survive later admin renames/deletions —
 *   same convention as the production StockChangeLog audit entity.
 * - `channels` holds BOTH source and destination channels so each side sees the
 *   transfer in its own channel-scoped lists, and no third channel ever does (GT-12).
 *
 * driverName / driverPhone / vehicleNumber are optional and exist only to be printed
 * on the transfer document. This module is not a logistics tracker: nothing reads them
 * back, and no behaviour depends on them.
 */
@Entity()
@Index(['state', 'sourceChannelId'])
@Index(['state', 'destinationChannelId'])
// PLAN.md §2.4 — the sequence is per source channel by construction (its group key
// carries the channelId), so uniqueness is asserted over the same pair. A global
// unique on transferNumber alone would claim something the design never promised.
@Index(['sourceChannelId', 'transferNumber'], { unique: true })
export class GoodsTransfer extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<GoodsTransfer>) {
        super(input);
    }

    /** Human-readable number, e.g. TRF-MAD-0142|26-27 (assigned at creation, PLAN.md §2.4). */
    @Column()
    transferNumber: string;

    @Column('varchar', { default: TransferState.Draft })
    state: TransferState;

    @EntityId()
    sourceChannelId: ID;

    @EntityId()
    destinationChannelId: ID;

    /**
     * The DESTINATION StockLocation, pinned at Confirm so later channel-configuration
     * edits can never redirect a transfer that is already moving. Nullable while DRAFT.
     *
     * There is deliberately NO source counterpart (GT-01). The source is a dispatch
     * point, not an inventory-managed location, so its stock is never read or written.
     * A sourceStockLocationId field would be a field someone eventually writes to;
     * removing it makes GT-01 structurally impossible to break rather than merely
     * documented — and resolving one could only ever FAIL a confirm, for a value
     * nothing consumes.
     */
    @EntityId({ nullable: true })
    destinationStockLocationId: ID | null;

    /** Asset id of the generated Transfer PDF (permanent, re-downloadable). */
    @EntityId({ nullable: true })
    pdfAssetId: ID | null;

    @Column('varchar', { nullable: true })
    remarks: string | null;

    /**
     * Optional transport details (both optional). This project is not a logistics
     * tracker — these are captured only for the transfer document if the branch
     * chooses to fill them.
     */
    @Column('varchar', { nullable: true })
    driverName: string | null;

    @Column('varchar', { nullable: true })
    driverPhone: string | null;

    @Column('varchar', { nullable: true })
    vehicleNumber: string | null;

    // ---- actor snapshots + timestamps per state transition ----

    /**
     * Set only when the DESTINATION raised this row as an item request, and never
     * cleared afterwards.
     *
     * `state` cannot answer "was this asked for?" on its own: the moment the source
     * accepts a request it becomes DRAFT and is indistinguishable from a load the
     * source started itself. The requesting branch still needs its own asks back in a
     * list, through confirm, dispatch and receipt, so the fact is recorded once here
     * rather than inferred later from a state that has already moved on.
     */
    @Column({ type: 'datetime', nullable: true })
    requestedAt: Date | null;

    @Column('varchar', { nullable: true })
    requestedByName: string | null;

    @EntityId({ nullable: true })
    createdById: ID | null;

    /** Shown as "prepared by" on the Transfer PDF (BRS §10). */
    @Column('varchar', { default: '' })
    createdByName: string;

    @Column({ type: 'datetime', nullable: true })
    confirmedAt: Date | null;

    @Column('varchar', { nullable: true })
    confirmedByName: string | null;

    @Column({ type: 'datetime', nullable: true })
    dispatchedAt: Date | null;

    @Column('varchar', { nullable: true })
    dispatchedByName: string | null;

    /**
     * When the destination accepted the goods, and who accepted them.
     *
     * The DB columns are deliberately still named approvedAt / approvedByName. The
     * property and the API say "received" because "approved" was ambiguous — a
     * transfer receipt and a damage approval are different decisions by different
     * branches. Renaming the column itself would mean synchronize dropping the old one
     * and creating an empty new one, losing who received every past transfer. The
     * alias costs nothing and keeps that history intact; the column can be renamed
     * later in a proper migration window.
     */
    @Column({ type: 'datetime', nullable: true, name: 'approvedAt' })
    receivedAt: Date | null;

    @Column('varchar', { nullable: true, name: 'approvedByName' })
    receivedByName: string | null;

    // ---- relations ----

    @OneToMany(() => GoodsTransferLine, line => line.transfer)
    lines: GoodsTransferLine[];

    /** Source + destination channels — both sides list the transfer (BR-03). */
    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];
}
