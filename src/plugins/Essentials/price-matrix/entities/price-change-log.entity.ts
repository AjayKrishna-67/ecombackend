import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * Immutable audit row: one variant×channel price change made via the Price
 * Update grid. Names are SNAPSHOTTED at write time so the log stays readable
 * even after a variant, channel, or administrator is later deleted. `oldPrice`
 * null = first price ever set for that (variant, channel). Prices are integer
 * minor units (paise), matching the core Money scalar.
 */
@Entity()
export class PriceChangeLog extends VendureEntity {
    constructor(input?: DeepPartial<PriceChangeLog>) {
        super(input);
    }

    @EntityId()
    @Index()
    variantId: ID;

    @Column()
    variantName: string;

    @EntityId()
    @Index()
    channelId: ID;

    @Column()
    channelName: string;

    @Column('int', { nullable: true })
    oldPrice: number | null;

    @Column('int')
    newPrice: number;

    @Column()
    currencyCode: string;

    @EntityId({ nullable: true })
    adminId: ID | null;

    @Column()
    adminName: string;
}
