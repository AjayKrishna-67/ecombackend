import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, OneToMany } from 'typeorm';

import { DamageState } from '../types';
import { DamageRequestLine } from './damage-request-line.entity';
import { GoodsTransfer } from './goods-transfer.entity';

/**
 * A damage claim against one (APPROVED) Goods Transfer.
 *
 * This row is the HEADER only — the damaged products live in `lines`, one per
 * product, so a branch reports everything it found in a single request instead of
 * one request per item.
 *
 * State machine: PENDING_APPROVAL -> APPROVED | REJECTED. Created already sent;
 * there is deliberately no draft and no revert.
 *
 * Stock is NEVER touched before approval; the deduction happens exclusively
 * inside the approval transaction, and is blocked when current destination stock
 * is insufficient (negative stock is never allowed). Approval covers the whole
 * request — per-product approval is not offered.
 */
@Entity()
@Index(['transferId', 'state'])
// Global unique, unlike GoodsTransfer which pairs its number with sourceChannelId.
// The difference is not a preference: GoodsTransfer HAS a channel column to pair with,
// and this row does not — it reaches its channel only through the transfer. A global
// constraint is what can be asserted here.
//
// It holds because the number carries a channel-derived prefix. The one way to break
// it is for two channels to be given the identical invoicePrefix by hand, and then the
// second claim fails loudly on this constraint instead of two claims quietly sharing a
// name. A visible failure is the better of those two.
@Index(['damageNumber'], { unique: true })
export class DamageRequest extends VendureEntity {
    constructor(input?: DeepPartial<DamageRequest>) {
        super(input);
    }

    /**
     * Human-readable number, e.g. DMG-M-0007|26-27 — assigned at creation, kept for
     * life (PLAN.md §2.4).
     *
     * Issued when the claim is raised, not when it is decided: a record somebody can
     * see must be nameable from the moment it exists, or "the damage I reported
     * yesterday" has nothing to refer to.
     *
     * Sequenced per DESTINATION channel, because that is the branch that raises the
     * claim — mirroring the transfer number, which is sequenced per source.
     */
    @Column()
    damageNumber: string;

    @ManyToOne(() => GoodsTransfer, { onDelete: 'CASCADE' })
    transfer: GoodsTransfer;

    @EntityId()
    transferId: ID;

    @Column('varchar', { default: DamageState.PendingApproval })
    state: DamageState;

    /** Free text for the whole request — optional. */
    @Column('varchar', { nullable: true })
    remarks: string | null;

    @EntityId({ nullable: true })
    pdfAssetId: ID | null;

    // ---- actor snapshots + timestamps ----

    @EntityId({ nullable: true })
    createdById: ID | null;

    @Column('varchar', { default: '' })
    createdByName: string;

    @Column({ type: 'datetime', nullable: true })
    approvedAt: Date | null;

    @Column('varchar', { nullable: true })
    approvedByName: string | null;

    // ---- relations ----

    @OneToMany(() => DamageRequestLine, line => line.damageRequest)
    lines: DamageRequestLine[];
}
