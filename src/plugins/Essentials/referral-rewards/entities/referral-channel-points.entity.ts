import { DeepPartial, VendureEntity, ChannelAware, Channel } from '@vendure/core';
import { Column, Entity, ManyToMany, JoinTable } from 'typeorm';

@Entity()
export class ReferralChannelPoints extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<ReferralChannelPoints>) {
        super(input);
    }

    @Column({ default: 0 })
    points: number;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];
}
