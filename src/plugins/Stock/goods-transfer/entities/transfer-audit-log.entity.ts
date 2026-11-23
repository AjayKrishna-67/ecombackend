import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * Immutable audit row (TDS §20) — blueprint: the production StockChangeLog
 * (location-stock plugin) snapshot-audit pattern. Rows are written in the SAME
 * transaction as the action they record ("an unauditable action must not
 * commit") and are never updated or deleted.
 *
 * Also the data source of the Stock Movement report (BRS §9.7) — which is
 * defined as Goods-Transfer-caused movements ONLY, so projecting this table
 * guarantees exactly that scope.
 */
@Entity()
@Index(['transferId', 'createdAt'])
export class TransferAuditLog extends VendureEntity {
    constructor(input?: DeepPartial<TransferAuditLog>) {
        super(input);
    }

    @EntityId()
    transferId: ID;

    /** Set when the action belongs to a damage request. */
    @EntityId({ nullable: true })
    damageRequestId: ID | null;

    /**
     * Action name, e.g. CREATED, LINE_ADDED, LINE_REMOVED, CONFIRMED,
     * DISPATCHED, RECEIPT_APPROVED, STOCK_APPLIED, DAMAGE_CREATED,
     * DAMAGE_CONFIRMED, DAMAGE_APPROVED, STOCK_DEDUCTED, ROUTE_CHANGED.
     */
    @Column('varchar')
    action: string;

    @Column('varchar', { nullable: true })
    fromState: string | null;

    @Column('varchar', { nullable: true })
    toState: string | null;

    @EntityId({ nullable: true })
    actorId: ID | null;

    /**
     * Name of the admin who performed the action (snapshot — survives renames and
     * deletions). Column keeps its original name so existing rows are not lost.
     */
    @Column('varchar', { name: 'actorName', default: '' })
    userName: string;

    /** Structured details, e.g. per-line old→new stock values on approvals. */
    @Column('simple-json', { nullable: true })
    data: Record<string, unknown> | null;
}
