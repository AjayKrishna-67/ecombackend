import { Channel, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, JoinTable, ManyToMany, OneToMany } from 'typeorm';
import { AddonItem } from './addon-item.entity';

export enum AddonSelectionType {
    CHECKBOX = 'CHECKBOX',
    QUANTITY = 'QUANTITY',
}

@Entity()
export class AddonGroup extends VendureEntity {
    constructor(input?: DeepPartial<AddonGroup>) {
        super(input);
    }

    @Column()
    name: string;

    @Column({ type: 'text', nullable: true })
    description: string;

    @Column({ type: 'enum', enum: AddonSelectionType, default: AddonSelectionType.CHECKBOX })
    selectionType: AddonSelectionType;

    @Column({ default: false })
    isRequired: boolean;

    @Column({ default: 0 })
    minSelections: number;

    @Column({ default: 1 })
    maxSelections: number;

    @Column({ default: 0 })
    sortOrder: number;

    @Column({ default: true })
    enabled: boolean;

    @OneToMany(() => AddonItem, item => item.group, { eager: true })
    items: AddonItem[];

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];
}
