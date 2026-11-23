import { VendureEntity, DeepPartial, Product, Customer, Channel, ChannelAware } from '@vendure/core';
import { Entity, ManyToOne, ManyToMany, JoinTable, Index } from 'typeorm';

@Entity()
@Index(['customer', 'product'])
export class Favorite extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<Favorite>) {
        super(input);
    }

    @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
    @Index()
    customer!: Customer;

    @ManyToOne(() => Product, { onDelete: 'CASCADE' })
    @Index()
    product!: Product;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels!: Channel[];
}
