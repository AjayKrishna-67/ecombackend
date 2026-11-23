import { DeepPartial, VendureEntity, ChannelAware, Channel, Customer, Order } from '@vendure/core';
import { Column, Entity, ManyToOne, ManyToMany, JoinTable } from 'typeorm';
import { LoyaltyTransactionType } from '../gql/generated';

@Entity()
export class LoyaltyPointsTransaction extends VendureEntity implements ChannelAware {
    constructor(input?: DeepPartial<LoyaltyPointsTransaction>) {
        super(input);
    }

    @Column({ type: 'enum', enum: LoyaltyTransactionType })
    type: LoyaltyTransactionType;

    @Column()
    note: string;

    @Column()
    value: number;

    @Column()
    code: string;

    @ManyToOne(() => Customer)
    customer: Customer;

    @ManyToOne(() => Order, { nullable: true })
    order: Order | null;

    @ManyToMany(() => Channel)
    @JoinTable()
    channels: Channel[];
}