import { Administrator, Asset, Channel, DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import {
    AvailabilityAction,
    AvailabilityScheduleMode,
    AvailabilityTargetType,
    DEFAULT_SCHEDULE_KIND,
    DEFAULT_SCHEDULE_TIMEZONE,
    ReportDateRangeMode,
    ScheduledReportType,
    ScheduleKind,
} from '../constants';
// Type-only: the run entity imports this one, so a value import would close a
// module cycle and TypeORM would fail to resolve column types at decoration time.
import type { AvailabilityScheduleRun } from './availability-schedule-run.entity';

/**
 * A SuperAdmin's intent: "make this product/collection available (or not) at
 * this time, on this channel". Editable. Occurrences are materialised from it
 * into AvailabilityScheduleRun rows, which hold the facts.
 *
 * `targetId` is polymorphic across Product and Collection, so it carries no
 * foreign key and no CASCADE. A deleted target therefore leaves the rule
 * behind; the applier surfaces that as a FAILED run with "target not found"
 * rather than silently dropping it.
 */
@Entity()
export class AvailabilitySchedule extends VendureEntity {
    constructor(input?: DeepPartial<AvailabilitySchedule>) {
        super(input);
    }

    /**
     * Which half of this table a row belongs to.
     *
     * AVAILABILITY rows carry targetType/targetId and the disable/enable cron
     * pair. REPORT rows carry sendCron and the report columns, and leave the
     * target columns null. `assertValidRule` rejects any row that mixes them --
     * without that guard the nullable columns below would quietly become
     * "sometimes meaningful", and every read would be a guess.
     */
    @Index()
    @Column({ type: 'varchar', default: DEFAULT_SCHEDULE_KIND })
    kind: ScheduleKind;

    /** AVAILABILITY only. */
    @Column({ type: 'varchar', nullable: true })
    targetType: AvailabilityTargetType | null;

    /** AVAILABILITY only. */
    @EntityId({ nullable: true })
    targetId: ID | null;

    /** REPORT only. 5-field cron pattern, read in `timezone`. */
    @Column({ type: 'varchar', nullable: true })
    sendCron: string | null;

    /** REPORT only. */
    @Column({ type: 'varchar', nullable: true })
    reportType: ScheduledReportType | null;

    /**
     * REPORT only. Brand (Seller) the report aggregates over.
     *
     * Deliberately not the same as `channel`, which is the channel that owns the
     * rule: a rule living in Madurai can report across the whole Kaaikani brand.
     * The member channels are resolved at run time rather than frozen here, so a
     * city added to the brand later is picked up by existing rules.
     */
    @EntityId({ nullable: true })
    reportSellerId: ID | null;

    /**
     * REPORT only. SUPERSEDED by `reportSellerId` and no longer read or written.
     *
     * Kept because dropping a column is irreversible and this table's history is
     * already fragile. Treat any value here as stale: a rule's coverage comes
     * from its brand.
     */
    @Column({ type: 'simple-array', nullable: true })
    reportChannelIds: string[] | null;

    /** REPORT only. Recipient phone numbers in E.164 without the plus. */
    @Column({ type: 'simple-array', nullable: true })
    recipients: string[] | null;

    /** REPORT only. */
    @Column({ type: 'varchar', nullable: true })
    dateRangeMode: ReportDateRangeMode | null;

    /**
     * Required. A null channel would make the sweeper fall back to the default
     * channel and apply the rule to the wrong storefront, silently.
     */
    @ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn()
    channel: Channel;

    @Column({ type: 'varchar' })
    mode: AvailabilityScheduleMode;

    /** ONE_OFF only. Stored UTC. */
    @Column({ type: 'datetime', nullable: true })
    runAt: Date | null;

    /** ONE_OFF only. */
    @Column({ type: 'varchar', nullable: true })
    action: AvailabilityAction | null;

    /** RECURRING only. 5-field cron pattern, read in `timezone`. */
    @Column({ type: 'varchar', nullable: true })
    disableCron: string | null;

    /** RECURRING only. Null is legal: a rule may disable and never re-enable. */
    @Column({ type: 'varchar', nullable: true })
    enableCron: string | null;

    /**
     * IANA zone used to turn a cron pattern into a UTC instant. Never read back
     * when displaying a run — every stored datetime is already UTC.
     */
    @Column({ type: 'varchar', default: DEFAULT_SCHEDULE_TIMEZONE })
    timezone: string;

    @Column({ type: 'datetime', nullable: true })
    activeFrom: Date | null;

    @Column({ type: 'datetime', nullable: true })
    activeUntil: Date | null;

    /** Pausing sets this false and CANCELLEDs pending runs, preserving history. */
    @Index()
    @Column({ default: true })
    isEnabled: boolean;

    @Column({ type: 'varchar', nullable: true })
    label: string | null;

    /** SET NULL so the audit trail outlives the administrator record. */
    @ManyToOne(() => Administrator, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn()
    createdByAdmin: Administrator | null;

    /**
     * Most recently executed run, or null if this rule has never fired.
     *
     * Deliberately not a column and not a relation: it is derived state, attached
     * by the service after a list query so the admin UI can answer "did this
     * actually trigger?" without one extra request per row. TypeORM ignores
     * undecorated properties, so nothing about the schema changes.
     */
    latestRun?: AvailabilityScheduleRun | null;

    /** Earliest run still pending, or null if nothing is materialised ahead. */
    nextRun?: AvailabilityScheduleRun | null;

    /**
     * Display name of the target, resolved in the rule's own channel.
     *
     * Also derived, for the same reason as `latestRun`: `targetId` is
     * polymorphic and carries no foreign key, so there is no relation to load.
     * Null means the product or collection no longer exists — which is worth
     * showing, because the rule will keep failing until someone deletes it.
     */
    targetName?: string | null;

    /**
     * REPORT only. The brand's name, derived like `targetName` — there is no
     * relation on this entity, only the seller id.
     */
    reportSellerName?: string | null;

    /**
     * REPORT only. The brand's member channels as resolved when the row was
     * read. Derived, and deliberately not stored: freezing it here is exactly
     * what `reportChannelIds` did, and why a new city never joined a report.
     */
    reportChannels?: Channel[];

    /** The target's featured asset, if it has one. Derived, like `targetName`. */
    targetAsset?: Asset | null;
}
