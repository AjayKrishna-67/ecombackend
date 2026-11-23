import { VendureEntity } from '@vendure/core';
import type { DeepPartial } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * Last-known presence of a delivery person, upserted by driverHeartbeat.
 * Fleet state is DERIVED from this + open rides at query time, never stored:
 * silence (lastHeartbeatAt older than the threshold) means the app is closed.
 */
@Entity('driver_status')
@Index(['administratorId', 'channelId'], { unique: true })
export class DriverStatus extends VendureEntity {
    constructor(input?: DeepPartial<DriverStatus>) {
        super(input);
    }

    @Column({ type: 'varchar', length: 36 })
    administratorId: string;

    @Column({ type: 'varchar', length: 36 })
    channelId: string;

    @Column({ type: 'double', nullable: true })
    lat: number | null;

    @Column({ type: 'double', nullable: true })
    lng: number | null;

    @Column({ default: false })
    gpsOn: boolean;

    @Column({ type: 'datetime', nullable: true })
    lastHeartbeatAt: Date | null;
}
