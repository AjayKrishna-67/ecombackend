import { DeepPartial, VendureEntity, ChannelAware, Channel, Customer, Order } from '@vendure/core';
import { Column, Entity, ManyToOne, ManyToMany, JoinTable, Index } from 'typeorm';

export enum ReferralStatus {
    REGISTERED = 'REGISTERED',
    ELIGIBLE = 'ELIGIBLE',
    CLAIMED = 'CLAIMED',
}

@Entity()
export class Referral extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<Referral>) {
        super(input);
    }

    @ManyToOne(() => Customer, { eager: false })
    referrer: Customer;

    @Index()
    @Column()
    referrerId: number;

    @ManyToOne(() => Customer, { eager: false })
    referredCustomer: Customer;

    @Index()
    @Column()
    referredCustomerId: number;

    @ManyToOne(() => Order, { nullable: true })
    order: Order | null;

    @Column({ type: 'enum', enum: ReferralStatus, default: ReferralStatus.REGISTERED })
    status: ReferralStatus;

    @Column({ default: 0 })
    points: number;

    @Column({ default: false })
    isScratched: boolean;

    @Column({ nullable: true })
    note: string;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];
}
