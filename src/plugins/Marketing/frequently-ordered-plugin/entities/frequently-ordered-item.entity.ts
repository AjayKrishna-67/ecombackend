import { DeepPartial, ID, ProductVariant, VendureEntity, EntityId, Channel, ChannelAware } from '@vendure/core';
import { Column, Entity, ManyToOne, ManyToMany, JoinTable, Index } from 'typeorm';

@Entity()
@Index(['customerId', 'productVariantId'])
export class FrequentlyOrderedItem extends VendureEntity implements ChannelAware {
  constructor(input?: DeepPartial<FrequentlyOrderedItem>) {
    super(input);
  }

  @Column('varchar')
  @Index()
  customerId: ID;

  @ManyToOne(() => ProductVariant)
  productVariant: ProductVariant;

  @EntityId()
  productVariantId: ID;

  @Column({ default: 0 })
  orderCount: number;

  @ManyToMany(() => Channel)
  @JoinTable()
  channels: Channel[];
}