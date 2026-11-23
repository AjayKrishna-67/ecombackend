import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * Immutable audit row: one stock on-hand change made via the Location Stock
 * tool. Mirrors PriceChangeLog. Names are SNAPSHOTTED at write time so the log
 * stays readable after a variant, product, location, or admin is later renamed
 * or deleted (that is why locationName/targetName/adminName are flat columns,
 * not joins).
 *
 * `kind` says which tool path wrote it:
 *   'variant'      -> targetId is a ProductVariant id, value is a sellable count
 *   'product-pool' -> targetId is a Product id, value is the weight pool
 *
 * `unit` is the BASE unit code ('g' | 'ml' | 'piece'), and oldOnHand/newOnHand
 * are integers in that base. The display unit (kg vs g, etc.) is computed at
 * render time from magnitude, never stored — so the row stays self-describing.
 * `oldOnHand` null = first time stock was set for that (target, location).
 */
@Index(['stockLocationId', 'createdAt'])
@Entity()
export class StockChangeLog extends VendureEntity {
    constructor(input?: DeepPartial<StockChangeLog>) {
        super(input);
    }

    @Column()
    kind: string;

    @Column()
    unit: string;

    @EntityId()
    @Index()
    targetId: ID;

    @Column()
    targetName: string;

    @EntityId()
    @Index()
    stockLocationId: ID;

    @Column()
    locationName: string;

    @Column('int', { nullable: true })
    oldOnHand: number | null;

    @Column('int')
    newOnHand: number;

    @EntityId({ nullable: true })
    adminId: ID | null;

    @Column()
    adminName: string;
}
