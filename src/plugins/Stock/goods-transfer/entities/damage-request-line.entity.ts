import { Asset, DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinTable, ManyToMany, ManyToOne } from 'typeorm';

import { DamageRequest } from './damage-request.entity';
import { GoodsTransferLine } from './goods-transfer-line.entity';

/**
 * One damaged product inside a DamageRequest.
 *
 * A request covers as many products as the branch found damaged in a single
 * transfer, so a hundred damaged products are one request, not a hundred.
 *
 * Everything that used to sit on the request itself lives here instead, because
 * each product has its own quantity, its own percentage and its own evidence:
 *  - receivedQtySnapshot freezes the received quantity of the transfer line, so
 *    the cumulative cap (pending + approved <= received) stays stable per product
 *  - damagePercent is an indicator only — it never gates the workflow, but it does
 *    decide whether a photo is required for THIS product (>= 5%)
 *
 * Approval is still taken on the whole request; per-line approval was considered
 * and deliberately left out.
 */
@Entity()
@Index(['damageRequestId'])
export class DamageRequestLine extends VendureEntity {
    constructor(input?: DeepPartial<DamageRequestLine>) {
        super(input);
    }

    @ManyToOne(() => DamageRequest, request => request.lines, { onDelete: 'CASCADE' })
    damageRequest: DamageRequest;

    @EntityId()
    damageRequestId: ID;

    /** The transfer line this damage was recorded against. */
    @ManyToOne(() => GoodsTransferLine, { onDelete: 'CASCADE' })
    line: GoodsTransferLine;

    @EntityId()
    lineId: ID;

    /** Name snapshot — survives later product renames. */
    @Column('varchar', { default: '' })
    productName: string;

    @Column('varchar', { default: '' })
    sku: string;

    /** Mirrors the transfer line: true = product-level pool, false = pieces. */
    @Column('boolean', { default: false })
    isPooled: boolean;

    /**
     * Mirrors the transfer line's poolUnit — what damagedGrams and
     * receivedQtySnapshot are counted in: 'kg', 'litre' or 'piece'.
     *
     * Copied from the line rather than re-derived, so a claim always reads in the
     * same unit as the delivery it is made against even if the product is re-authored
     * afterwards. Null on a PCS line and on rows written before units were recorded.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    poolUnit: string | null;

    /** Set for PCS lines; null for pool lines (same XOR rule as the transfer line). */
    @Column('int', { nullable: true })
    damagedPcs: number | null;

    /**
     * The damaged pool quantity as an integer in the pool's BASE unit — grams,
     * millilitres or pieces, per poolUnit. Null for PCS lines. Named for grams for
     * the same historical reason as GoodsTransferLine.weightGrams.
     */
    @Column('int', { nullable: true })
    damagedGrams: number | null;

    /** Received quantity of the transfer line when this was raised, in the same unit. */
    @Column('int')
    receivedQtySnapshot: number;

    /** (damaged / received) x 100 — indicator only, 2 decimals. */
    @Column('decimal', { precision: 5, scale: 2, nullable: true })
    damagePercent: string | null;

    /** Free text the branch may add per product — optional. */
    @Column('varchar', { nullable: true })
    note: string | null;

    /**
     * Evidence for THIS product — required when its damage reaches 5% (GT-11).
     *
     * Core Assets held through a join table, the same way banners hold theirs. There
     * used to be a DamagePhoto entity wrapping an assetId and a filename snapshot;
     * it was a join table with extra steps. The filename is on the Asset already, and
     * if the Asset is ever deleted the photo is gone regardless — so a snapshot of its
     * name preserved nothing.
     *
     * Reading them now yields the URL directly (`photos { source preview }`) instead
     * of an id that had to be resolved in a second call.
     */
    @ManyToMany(() => Asset)
    @JoinTable()
    photos: Asset[];
}
