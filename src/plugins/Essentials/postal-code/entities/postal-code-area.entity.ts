import { DeepPartial, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToOne, Index } from 'typeorm';
import { PostalCode } from './postal-code.entity';

@Entity()
export class PostalCodeArea extends VendureEntity {
    constructor(input?: DeepPartial<PostalCodeArea>) {
        super(input);
    }

    @Column()
    @Index()
    name: string;

    @Column({ default: true })
    enabled: boolean;

    @ManyToOne(() => PostalCode, postalCode => postalCode.areas, { onDelete: 'CASCADE' })
    postalCode: PostalCode;
}
