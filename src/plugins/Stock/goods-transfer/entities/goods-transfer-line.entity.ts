import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { GoodsTransfer } from './goods-transfer.entity';

/**
 * One product line of a Goods Transfer (TDS §4, BRS §4).
 *
 * Quantity rule: exactly ONE of quantityPcs / weightGrams is set (XOR — validated in
 * the service layer, TDS §21). A pool quantity is stored as an INTEGER IN ITS BASE
 * UNIT (house stock-units convention shared with the existing Stock plugins) — grams
 * for a weighed product, pieces for a counted one, and `poolUnit` says which.
 *
 * Snapshots (productName / sku / isPooled / poolUnit) are taken when the line is
 * added so that documents & history stay correct even if the Product Master changes
 * later, and so the stock-update path (PCS vs pool, and the pool's unit) is
 * deterministic at approval time (mismatch with the live values aborts approval —
 * TDS §19).
 *
 * NO barcode field (BRS §12).
 */
@Entity()
@Index(['transferId'])
export class GoodsTransferLine extends VendureEntity {
    constructor(input?: DeepPartial<GoodsTransferLine>) {
        super(input);
    }

    @ManyToOne(() => GoodsTransfer, transfer => transfer.lines, { onDelete: 'CASCADE' })
    transfer: GoodsTransfer;

    @EntityId()
    transferId: ID;

    /**
     * FK to the existing Product Master (read-only reference — BR-05/17).
     * NULL for pool (weight) lines — pool entry is PRODUCT-level (Q3a confirmed);
     * the existing pool system auto-splits availability across variants.
     */
    @EntityId({ nullable: true })
    productVariantId: ID | null;

    @EntityId()
    productId: ID;

    @Column()
    productName: string;

    /** Variant SKU for PCS lines; '' for product-level pool lines. */
    @Column({ default: '' })
    sku: string;

    /** Snapshot of Product.customFields.productStockEnabled at add-time. */
    @Column({ default: false })
    isPooled: boolean;

    /**
     * What this line's pool is counted in: 'kg', 'litre' or 'piece'. Null on a PCS
     * line, which has no pool, and on rows written before the unit was read at all.
     *
     * Snapshotted for the same reason isPooled is: the unit is derived from the
     * product's measurement option, and an option group edited while goods are in a
     * vehicle would otherwise reinterpret a number already printed on the paperwork.
     * A 30 that meant thirty lemons must not become thirty grams because somebody
     * retyped an option that afternoon. TransferStockService checks this against the
     * live value and refuses the receipt rather than guessing.
     *
     * Null on a legacy row means "never recorded", NOT kilograms — the receipt path
     * treats it as unknown and falls back to the live unit.
     */
    @Column({ type: 'varchar', length: 16, nullable: true })
    poolUnit: string | null;

    /** Set for piece-counted products; null for weight-pool products. */
    @Column('int', { nullable: true })
    quantityPcs: number | null;

    /**
     * The pool quantity, as an integer in the pool's BASE unit — grams for a kg pool,
     * millilitres for a litre pool, pieces for a counted one. Null for PCS products.
     *
     * The name is historical: this module was built when every pool was assumed to be
     * a weight, and renaming the column would rewrite every query and report for no
     * behavioural gain. Read it with `poolUnit` beside it; `weightGrams` alone means
     * grams only when `poolUnit` is a weight.
     */
    @Column('int', { nullable: true })
    weightGrams: number | null;

    /**
     * When the expiry warning for this line was raised. The scheduler runs daily and
     * a line stays past its threshold every day after it first crosses it, so this
     * stamp is what keeps the branch from being told the same thing every morning.
     * Set once, never cleared — the same product arriving on a LATER transfer is a
     * different line and warns again on its own schedule.
     */
    @Column({ type: 'datetime', nullable: true })
    expiryNotifiedAt: Date | null;
}
