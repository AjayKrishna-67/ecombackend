import { DeepPartial, VendureEntity, ChannelAware, Channel } from '@vendure/core';
import { Column, Entity, ManyToMany, JoinTable } from 'typeorm';

@Entity()
export class LoyaltyPointsConfig extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<LoyaltyPointsConfig>) {
        super(input);
    }

    @Column()
    rupeesPerPoint: number;

    @Column()
    pointsPerRupee: number;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];
}