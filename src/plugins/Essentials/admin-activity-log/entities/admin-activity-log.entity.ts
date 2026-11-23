import { DeepPartial, EntityId, ID, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';
import { FieldChange } from '../services/diff-payload';

export type AdminActivityOutcome = 'SUCCESS' | 'ERROR';

/**
 * Immutable audit row: one admin-API mutation performed by one administrator.
 *
 * Names are SNAPSHOTTED at write time so the log stays readable after the
 * administrator, channel, or target entity is later deleted. `payload` holds the
 * SANITIZED mutation arguments — credential-bearing keys are stripped and the
 * whole blob is size-capped before it reaches this table.
 *
 * `sessionId` is the Session's primary key, never the session token: the raw
 * token is a live credential and must never be persisted in a readable table.
 * It exists so a working day can be grouped into one timeline per device rather
 * than merging an administrator's concurrent sessions into one stream.
 *
 * Rows are append-only. Nothing updates or locks them; retention is handled by
 * the prune task.
 */
@Entity()
@Index(['entityType', 'entityId'])
@Index(['adminId', 'createdAt'])
@Index(['sessionId', 'createdAt'])
export class AdminActivityLog extends VendureEntity {
    constructor(input?: DeepPartial<AdminActivityLog>) {
        super(input);
    }

    /** GraphQL mutation field name, e.g. `deleteProduct`, `setVariantChannelPrices`. */
    @Column('varchar', { length: 255 })
    @Index()
    operationName: string;

    /** Best-effort target entity type derived from the mutation name, e.g. `Product`. */
    @Column('varchar', { length: 255, nullable: true })
    entityType: string | null;

    /**
     * Best-effort target entity id derived from the mutation arguments. Stored as a
     * string because ids are heterogeneous across the admin API and this column is
     * never joined on, only filtered.
     */
    @Column('varchar', { length: 255, nullable: true })
    entityId: string | null;

    /** Number of entities this single mutation targeted, for blast-radius reporting. */
    @Column('int', { default: 1 })
    targetCount: number;

    /** Sanitized, size-capped mutation arguments. */
    @Column('simple-json', { nullable: true })
    payload: Record<string, unknown> | null;

    /**
     * Dotted paths of the fields this mutation actually changed, e.g.
     * `translations.en.description`, `customFields.localName`, `enabled`.
     *
     * Computed at flush time by diffing this payload against the previous logged
     * payload for the same entity, because the Dashboard submits the entire form
     * on every save — the payload alone cannot distinguish an edited field from
     * an untouched one that was simply resubmitted.
     *
     * `null` means no comparison was possible: the first recorded change to an
     * entity, an operation with no identifiable target, or a create/delete where
     * a field-level diff is meaningless.
     */
    @Column('simple-json', { nullable: true })
    changedFields: string[] | null;

    @Column('varchar', { length: 16 })
    outcome: AdminActivityOutcome;

    @Column('text', { nullable: true })
    errorMessage: string | null;

    @EntityId({ nullable: true })
    adminId: ID | null;

    @Column('varchar', { length: 255 })
    adminName: string;

    /**
     * The Session's primary key — never the session token, which is a live
     * credential. Storing the id groups a working day per device AND joins back
     * to the Session row, where the device fingerprint (userAgent, ipAddress,
     * lastSeenAt) is kept.
     */
    @Column('varchar', { length: 64, nullable: true })
    @Index()
    sessionId: string | null;

    @EntityId({ nullable: true })
    channelId: ID | null;

    @Column('varchar', { length: 64, nullable: true })
    ipAddress: string | null;

    @Column('int', { default: 0 })
    durationMs: number;

    /** True when the row records an authentication event rather than a data mutation. */
    @Column({ default: false })
    isAuthEvent: boolean;

    /**
     * NOT a column. Populated at read time by joining `sessionId` to the Session
     * row, where the user agent is stored once per session rather than copied
     * onto every action. Undefined on rows loaded by paths that do not resolve it.
     */
    userAgent?: string | null;

    /**
     * NOT a column. The same diff that produced `changedFields`, re-run at read
     * time against this row's predecessor so each path carries its before and
     * after value.
     *
     * Derived rather than stored because both payloads are already rows in this
     * table: persisting the values would write a third copy of the same bytes on
     * every mutation, forever, to save one query on a page a human opens twice a
     * week. It also means every row already in the table gains values with no
     * migration and no backfill.
     */
    changes?: FieldChange[] | null;

    /**
     * NOT a column. Display name of the target entity, read from this row's own
     * payload — the name as it was when the action happened, not as it is today.
     */
    entityLabel?: string | null;

    /**
     * NOT a column. Dashboard path for the target entity, or null when this row
     * must not be clickable. Null is the safety mechanism: `entityType` is
     * heuristic output and the table holds proven-nonsense values, so only an
     * allowlisted type ever produces a link.
     */
    entityLink?: string | null;
}
