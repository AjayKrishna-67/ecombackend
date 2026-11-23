import { Asset, DeepPartial, Seller, VendureEntity } from '@vendure/core';
import { Column, Entity, JoinColumn, ManyToOne, Index } from 'typeorm';

export type BrandLaunchStatus = 'OPENING_SOON' | 'LAUNCHED';

/**
 * Storefront presentation for a brand in the app "Switch Store" sheet.
 * Keyed to a Seller (one brand = one seller), NOT a channel: a brand like
 * Kaaikani spans several CITY channels but is a single switcher card.
 * Orthogonal to postal-code availability: `launchStatus` is an admin rollout
 * switch, not a delivery-area check.
 */
@Entity()
export class BrandStorefront extends VendureEntity {
    constructor(input?: DeepPartial<BrandStorefront>) {
        super(input);
    }

    @Index({ unique: true })
    @ManyToOne(() => Seller, { onDelete: 'CASCADE' })
    @JoinColumn()
    seller: Seller;

    @ManyToOne(() => Asset, { nullable: true, eager: true, onDelete: 'SET NULL' })
    @JoinColumn()
    bannerImage: Asset | null;

    @Column({ type: 'varchar', default: 'OPENING_SOON' })
    launchStatus: BrandLaunchStatus;

    @Column({ default: false })
    showInStoreSwitcher: boolean;

    @Column({ type: 'int', nullable: true })
    sortOrder: number | null;
}
