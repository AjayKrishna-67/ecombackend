import { Channel, DeepPartial, EntityId, ID, User, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import {
    AvailabilityChangeField,
    AvailabilityChangeSource,
    AvailabilityTargetType,
} from '../constants';

/**
 * Who flipped a product's `enabled` or a collection's `isPrivate`, and when.
 *
 * Vendure keeps no history for catalogue entities -- HistoryEntry covers only
 * Order and Customer -- so without this table "the schedule found it already
 * disabled, who did that?" is unanswerable.
 *
 * Written by an event subscriber that fires only when the relevant boolean
 * appears in the event input. ProductEvent is raised by every price sync,
 * import and stock update in this project; logging all of them would put
 * millions of rows here, while availability flips are rare.
 */
@Entity()
@Index(['targetType', 'targetId', 'createdAt'])
export class AvailabilityTargetChangeLog extends VendureEntity {
    constructor(input?: DeepPartial<AvailabilityTargetChangeLog>) {
        super(input);
    }

    @Column({ type: 'varchar' })
    targetType: AvailabilityTargetType;

    @EntityId()
    targetId: ID;

    /** Context channel of the request. Nullable: Product.enabled is global. */
    @ManyToOne(() => Channel, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn()
    channel: Channel | null;

    @Column({ type: 'varchar' })
    field: AvailabilityChangeField;

    /** The value written. For `isPrivate` this is the inverse of availability. */
    @Column()
    newValue: boolean;

    @Column({ type: 'varchar' })
    source: AvailabilityChangeSource;

    /** SET NULL so the record survives the account being removed. */
    @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn()
    changedByUser: User | null;
}
