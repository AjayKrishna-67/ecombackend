import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { AvailabilityAction, AvailabilityRunStatus } from '../constants';
import { AvailabilitySchedule } from './availability-schedule.entity';

/**
 * One materialised occurrence of a schedule, plus its outcome. Facts, not
 * intent: rows are never rewritten to a new time. Editing a rule deletes its
 * PENDING rows and re-materialises; DONE/FAILED rows are the audit trail and
 * are never touched.
 *
 * The unique (schedule, dueAt, action) index is what makes materialisation
 * idempotent. Inserting with conflict-ignore lets the sweep run twice, or after
 * a crash, or from two workers, with duplicates impossible at the engine level
 * -- a read-then-write existence check would leave a race between the two.
 */
@Entity()
@Index(['schedule', 'dueAt', 'action'], { unique: true })
@Index(['status', 'dueAt'])
export class AvailabilityScheduleRun extends VendureEntity {
    constructor(input?: DeepPartial<AvailabilityScheduleRun>) {
        super(input);
    }

    /** Required. An orphan run has no target, no channel and nothing to apply. */
    @ManyToOne(() => AvailabilitySchedule, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn()
    schedule: AvailabilitySchedule;

    /** The instant this occurrence is due, in UTC. */
    @Column({ type: 'datetime' })
    dueAt: Date;

    @Column({ type: 'varchar' })
    action: AvailabilityAction;

    @Column({ type: 'varchar', default: 'PENDING' })
    status: AvailabilityRunStatus;

    @Column({ type: 'int', default: 0 })
    attempts: number;

    @Column({ type: 'text', nullable: true })
    lastError: string | null;

    /**
     * Human-readable outcome detail. On a NOOP this names who left the target
     * in the wanted state, so the audit does not require joining the change log.
     */
    @Column({ type: 'text', nullable: true })
    note: string | null;

    @Column({ type: 'datetime', nullable: true })
    executedAt: Date | null;
}
