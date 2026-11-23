import {
    Asset,
    Channel,
    Collection,
    DeepPartial,
    Product,
    ProductVariant,
    VendureEntity,
} from '@vendure/core';
import { Column, Entity, ManyToMany, ManyToOne, JoinTable, JoinColumn, Index } from 'typeorm';

/**
 * A channel-scoped promotional offer image. Each offer carries
 * exactly ONE asset (image) and is linked to exactly ONE of:
 *   - a Product
 *   - a Collection (i.e. category)
 *   - a ProductVariant (i.e. SKU)
 *
 * The "exactly one" constraint is enforced in the service layer
 * because TypeORM cannot express XOR at the schema level.
 */
@Entity()
export class CustomOffer extends VendureEntity {
    constructor(input?: DeepPartial<CustomOffer>) {
        super(input);
    }

    // Single image — ManyToOne, not ManyToMany.
    @Index()
    @ManyToOne(() => Asset, { eager: true, nullable: false, onDelete: 'CASCADE' })
    @JoinColumn()
    asset: Asset;

    // Exactly one of the three targets below must be set (validated in service).
    @Index()
    @ManyToOne(() => Product, { eager: true, nullable: true, onDelete: 'CASCADE' })
    @JoinColumn()
    product: Product | null;

    @Index()
    @ManyToOne(() => Collection, { eager: true, nullable: true, onDelete: 'CASCADE' })
    @JoinColumn()
    collection: Collection | null;

    @Index()
    @ManyToOne(() => ProductVariant, { eager: true, nullable: true, onDelete: 'CASCADE' })
    @JoinColumn()
    productVariant: ProductVariant | null;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    /**
     * Rotation flag — `true` means the offer is still available to be served
     * by the shop API's `nextCustomOffer` query. Each time the storefront
     * fetches an offer it gets flipped to `false`. When every offer in the
     * channel has been served (all flags `false`), the service resets them
     * all back to `true` and the cycle starts over.
     */
    @Index()
    @Column({ default: true })
    isAvailable: boolean;

    /**
     * When true, the offer is in draft/preview mode and will NOT
     * appear in the shop API `nextCustomOffer` or `customOffers` queries.
     * Only visible in the admin UI for review before going live.
     */
    @Index()
    @Column({ default: false })
    isPreview: boolean;
}
