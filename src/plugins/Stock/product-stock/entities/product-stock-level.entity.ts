import { DeepPartial, Product, StockLocation, VendureEntity, ID } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, Unique } from 'typeorm';

@Entity()
@Unique(['productId', 'stockLocationId'])
export class ProductStockLevel extends VendureEntity {
  constructor(input?: DeepPartial<ProductStockLevel>) {
    super(input);
  }

  @Index()
  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  product: Product;

  @Column()
  productId: ID;

  @ManyToOne(() => StockLocation, { onDelete: 'CASCADE' })
  stockLocation: StockLocation;

  @Column()
  stockLocationId: ID;

  @Column({ type: 'int', default: 0 })
  stockOnHand: number;

  @Column({ type: 'int', default: 0 })
  stockAllocated: number;
}
