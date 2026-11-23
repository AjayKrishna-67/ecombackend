import { Asset, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { AddonGroup } from './addon-group.entity';

@Entity()
export class AddonItem extends VendureEntity {
    constructor(input?: DeepPartial<AddonItem>) {
        super(input);
    }

    @Column()
    name: string;

    @Column({ type: 'int', default: 0 })
    price: number;

    @Column({ nullable: true })
    sku: string;

    @Column({ default: false })
    isDefault: boolean;

    @Column({ type: 'int', default: 0 })
    minQuantity: number;

    @Column({ default: 1 })
    maxQuantity: number;

    @Column({ default: 0 })
    sortOrder: number;

    @Column({ default: true })
    enabled: boolean;

    @ManyToOne(() => AddonGroup, group => group.items, { onDelete: 'CASCADE' })
    @Index()
    group: AddonGroup;

    @ManyToOne(() => Asset, { nullable: true, eager: true, onDelete: 'SET NULL' })
    @JoinColumn()
    image: Asset | null;
}
