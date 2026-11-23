import { DeepPartial, ID, Product, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { CatalogTag } from './tag.entity';

/**
 * Join entity: a Tag attached to a Product.
 *
 * Owned join entity (not a relation custom field) so reverse traversal
 * (products-by-tag) is an indexed query. Unique on (productId, tagId) prevents
 * duplicate assignment. onDelete CASCADE: removing a Product or a Tag removes
 * the join row.
 */
@Entity()
@Index(['productId', 'tagId'], { unique: true })
export class ProductTag extends VendureEntity {
    constructor(input?: DeepPartial<ProductTag>) {
        super(input);
    }

    @ManyToOne(() => Product, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'productId' })
    product: Product;

    @Column()
    productId: ID;

    @ManyToOne(() => CatalogTag, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'tagId' })
    tag: CatalogTag;

    @Column()
    @Index()
    tagId: ID;
}
