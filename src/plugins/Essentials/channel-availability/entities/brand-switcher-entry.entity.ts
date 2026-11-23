import { DeepPartial, Seller, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

/**
 * One row = "brand `targetSeller` appears in `hostSeller`'s app switcher, at
 * position `sortOrder`". This is the per-app allowlist matrix: brand = Seller,
 * app = the host brand's channel. A row per (host, target) pair lets each app
 * curate its OWN ordered list — e.g. the SouthMithai app shows SouthMithai +
 * SipNourish but not Kaaikani. The single global `BrandStorefront.showInStoreSwitcher`
 * flag could not express that asymmetry.
 *
 * Brand CONTENT (banner, launch status) stays on `BrandStorefront`; this entity
 * is purely the wiring (who-shows-whom + per-app order).
 */
@Entity()
@Unique(['hostSeller', 'targetSeller'])
export class BrandSwitcherEntry extends VendureEntity {
    constructor(input?: DeepPartial<BrandSwitcherEntry>) {
        super(input);
    }

    @Index()
    @ManyToOne(() => Seller, { onDelete: 'CASCADE' })
    @JoinColumn()
    hostSeller: Seller;

    @ManyToOne(() => Seller, { onDelete: 'CASCADE' })
    @JoinColumn()
    targetSeller: Seller;

    @Column({ type: 'int', default: 0 })
    sortOrder: number;
}
