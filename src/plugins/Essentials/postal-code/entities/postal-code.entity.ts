import { Channel, DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, ManyToMany, JoinTable, Index, OneToMany } from 'typeorm';
import { PostalCodeArea } from './postal-code-area.entity';

@Entity()
@Index(['code', 'isAnywhere'])
export class PostalCode extends VendureEntity {
    constructor(input?: DeepPartial<PostalCode>) {
        super(input);
    }

    @Column()
    @Index()
    code: string;

    @Column({ default: false })
    @Index()
    isAnywhere: boolean;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];

    @OneToMany(() => PostalCodeArea, area => area.postalCode, { eager: false })
    areas: PostalCodeArea[];
}


