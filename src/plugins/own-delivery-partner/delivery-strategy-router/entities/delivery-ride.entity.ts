import { VendureEntity } from '@vendure/core';
import type { DeepPartial } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * One row per order delivery ride. Created when the driver starts the ride
 * (fulfillment → OutforDelivery), closed when the order is Delivered.
 * An open ride (deliveredAt IS NULL) is what powers ride-resume and the
 * "Out for delivery" fleet state; distanceMeters accumulates via heartbeats.
 */
@Entity('delivery_ride')
export class DeliveryRide extends VendureEntity {
    constructor(input?: DeepPartial<DeliveryRide>) {
        super(input);
    }

    @Index()
    @Column({ type: 'varchar', length: 36 })
    administratorId: string;

    @Index()
    @Column({ type: 'varchar', length: 36 })
    orderId: string;

    @Column({ type: 'varchar', length: 64 })
    orderCode: string;

    @Index()
    @Column({ type: 'varchar', length: 36 })
    channelId: string;

    @Index()
    @Column({ type: 'datetime' })
    startedAt: Date;

    @Column({ type: 'datetime', nullable: true })
    deliveredAt: Date | null;

    /** Cumulative odometer for this ride. Heartbeats report cumulative values; the server keeps the max. */
    @Column({ type: 'int', default: 0 })
    distanceMeters: number;
}
