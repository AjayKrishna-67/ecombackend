import { DeepPartial, ID, ProductVariant, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { CatalogTag } from './tag.entity';

/**
 * Join entity: a Tag attached to a ProductVariant.
 *
 * Mirrors ProductTag. Unique on (variantId, tagId). onDelete CASCADE on both
 * sides. productsByTag treats a variant-tag match as a match for the parent
 * product (decision 2A).
 */
@Entity()
@Index(['variantId', 'tagId'], { unique: true })
export class ProductVariantTag extends VendureEntity {
    constructor(input?: DeepPartial<ProductVariantTag>) {
        super(input);
    }

    @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'variantId' })
    variant: ProductVariant;

    @Column()
    variantId: ID;

    @ManyToOne(() => CatalogTag, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'tagId' })
    tag: CatalogTag;

    @Column()
    @Index()
    tagId: ID;
}
