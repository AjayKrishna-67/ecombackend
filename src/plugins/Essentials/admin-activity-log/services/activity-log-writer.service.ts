import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Administrator, ID, Logger, TransactionalConnection } from '@vendure/core';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ADMIN_ACTIVITY_LOG_CONFIG } from '../constants';
import { AdminActivityLog, AdminActivityOutcome } from '../entities/admin-activity-log.entity';
import { diffPayloads, toChangedPaths } from './diff-payload';

const LOGGER_CTX = 'AdminActivityLog';

type Json = Record<string, unknown>;

/**
 * Entities looked up per baseline query. Keeps each generated subquery small
 * enough to stay a normal indexed lookup regardless of how large a flush batch
 * grows.
 */
const BASELINE_CHUNK_SIZE = 50;

/** Composite lookup key for the (entityType, entityId) pair a row targets. */
function entityKey(entityType: string | null, entityId: string | null): string {
    return `${entityType ?? ''}::${entityId ?? ''}`;
}

const {
    FLUSH_INTERVAL_MS,
    FLUSH_ROW_THRESHOLD,
    MAX_BUFFER_ROWS,
} = ADMIN_ACTIVITY_LOG_CONFIG;

/**
 * A row awaiting its bulk insert. `userId` is deliberately unresolved here: the
 * interceptor holds a User id, and turning that into an administrator name costs
 * a query that must not happen inside the request path.
 */
export interface PendingActivityRow {
    operationName: string;
    entityType: string | null;
    entityId: string | null;
    targetCount: number;
    payload: Record<string, unknown> | null;
    outcome: AdminActivityOutcome;
    errorMessage: string | null;
    userId: ID | null;
    sessionId: string | null;
    channelId: ID | null;
    ipAddress: string | null;
    durationMs: number;
    isAuthEvent: boolean;
    fallbackAdminName?: string;
}

interface ResolvedAdmin {
    adminId: ID | null;
    adminName: string;
}

/**
 * Batches audit rows and writes them as a single bulk INSERT.
 *
 * Three properties this service must never violate:
 *
 * 1. **It never blocks a mutation.** `enqueue` is synchronous and does no I/O.
 *    A mutation must not fail, or slow down, because auditing failed.
 * 2. **It never grows without bound.** Past `MAX_BUFFER_ROWS` rows are dropped
 *    with a warning. A bulk price sync already took this server down once; an
 *    unbounded audit buffer must not cause the second outage.
 * 3. **It writes outside the request transaction.** Rows go through
 *    `rawConnection`, so a mutation that rolls back still leaves its audit trail
 *    — including the failed attempt, which is the whole point.
 */
@Injectable()
export class ActivityLogWriterService implements OnApplicationBootstrap, OnApplicationShutdown {
    private buffer: PendingActivityRow[] = [];
    private adminCache = new Map<string, ResolvedAdmin>();
    private flushTimer: NodeJS.Timeout | undefined;
    private droppedSinceLastWarning = 0;
    private isFlushing = false;

    constructor(private readonly connection: TransactionalConnection) {}

    /** @internal */
    onApplicationBootstrap(): void {
        this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
        this.flushTimer.unref();
    }

    /** @internal */
    async onApplicationShutdown(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
        }
        await this.flush();
    }

    /**
     * Queues one audit row. Synchronous and non-throwing by contract — callers
     * are in the request path and must never be delayed or broken by auditing.
     */
    enqueue(row: PendingActivityRow): void {
        if (this.buffer.length >= MAX_BUFFER_ROWS) {
            this.droppedSinceLastWarning++;
            return;
        }
        this.buffer.push(row);
        if (this.buffer.length >= FLUSH_ROW_THRESHOLD) {
            void this.flush();
        }
    }

    /**
     * Writes all buffered rows as one bulk INSERT. Safe to call concurrently;
     * overlapping calls return immediately rather than double-writing.
     */
    async flush(): Promise<void> {
        if (this.isFlushing || this.buffer.length === 0) {
            return;
        }
        this.isFlushing = true;
        const batch = this.buffer.splice(0, this.buffer.length);
        try {
            await this.writeBatch(batch);
            this.reportDroppedRows();
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to write ${batch.length} audit rows: ${message}`, LOGGER_CTX);
        } finally {
            this.isFlushing = false;
        }
    }

    private reportDroppedRows(): void {
        if (this.droppedSinceLastWarning === 0) {
            return;
        }
        Logger.warn(
            `Dropped ${this.droppedSinceLastWarning} audit rows: buffer exceeded ${MAX_BUFFER_ROWS}`,
            LOGGER_CTX,
        );
        this.droppedSinceLastWarning = 0;
    }

    private async writeBatch(batch: PendingActivityRow[]): Promise<void> {
        const userIds = batch.map(row => row.userId).filter((id): id is ID => id !== null);
        await this.warmAdminCache(userIds);
        const baselines = await this.loadBaselines(batch);
        const entities = batch.map(row => this.toEntity(row, baselines));
        await this.connection.rawConnection
            .getRepository(AdminActivityLog)
            .insert(entities as QueryDeepPartialEntity<AdminActivityLog>[]);
    }

    /**
     * Loads the most recent stored payload for every entity touched in this
     * batch, so each row can be diffed against what that entity looked like at
     * its last recorded change.
     *
     * Deliberately runs here rather than in the interceptor. The diff needs a
     * database read, and the interceptor sits in the request path where this
     * service's first invariant — never block a mutation — forbids I/O. At flush
     * time the same work costs one extra query per batch instead of one per
     * mutation.
     */
    private async loadBaselines(batch: PendingActivityRow[]): Promise<Map<string, Json>> {
        const targets = [
            ...new Map(
                batch
                    .filter(row => row.entityType !== null && row.entityId !== null)
                    .map(row => [entityKey(row.entityType, row.entityId), row]),
            ).values(),
        ];
        if (targets.length === 0) {
            return new Map();
        }
        // Chunked because a flush drains the WHOLE buffer, which can hold up to
        // MAX_BUFFER_ROWS rows. A product import touching two thousand entities
        // would otherwise build a single subquery with two thousand OR clauses
        // and four thousand bound parameters — the same shape of oversized query
        // that has taken this database down before. Several small indexed
        // queries are strictly safer than one enormous one.
        const baselines = new Map<string, Json>();
        for (let start = 0; start < targets.length; start += BASELINE_CHUNK_SIZE) {
            const chunk = targets.slice(start, start + BASELINE_CHUNK_SIZE);
            for (const [key, payload] of await this.loadBaselineChunk(chunk)) {
                baselines.set(key, payload);
            }
        }
        return baselines;
    }

    private async loadBaselineChunk(targets: PendingActivityRow[]): Promise<Map<string, Json>> {
        // One row per entity: the newest previously-stored payload. Expressed as
        // a correlated MAX(id) subquery rather than GROUP BY, because MySQL's
        // only_full_group_by rejects selecting a non-aggregated `payload`
        // alongside a grouped key.
        const qb = this.connection.rawConnection
            .getRepository(AdminActivityLog)
            .createQueryBuilder('log')
            .select(['log.entityType', 'log.entityId', 'log.payload'])
            .where('log.outcome = :outcome', { outcome: 'SUCCESS' })
            .andWhere(
                `log.id IN (
                    SELECT MAX(inner_log.id) FROM admin_activity_log inner_log
                    WHERE inner_log.outcome = 'SUCCESS'
                      AND inner_log.payload IS NOT NULL
                      AND (${targets
                          .map((_, i) => `(inner_log.entityType = :type${i} AND inner_log.entityId = :id${i})`)
                          .join(' OR ')})
                    GROUP BY inner_log.entityType, inner_log.entityId
                )`,
                Object.fromEntries(
                    targets.flatMap((row, i) => [
                        [`type${i}`, row.entityType],
                        [`id${i}`, row.entityId],
                    ]),
                ),
            );
        const rows = await qb.getMany();
        return new Map(
            rows
                .filter(row => row.payload !== null)
                .map(row => [entityKey(row.entityType, row.entityId), row.payload as Json]),
        );
    }

    /**
     * Builds the row by direct field assignment rather than the entity
     * constructor. `payload` is an open `Record<string, unknown>` by nature — the
     * arguments of an arbitrary mutation — and TypeORM's `DeepPartial` cannot
     * express `unknown` inside an index signature, so the constructor's
     * `DeepPartial` parameter rejects it. Assignment sidesteps that, leaving one
     * narrow cast at the `insert` boundary.
     */
    private toEntity(row: PendingActivityRow, baselines: Map<string, Json>): AdminActivityLog {
        const resolved = this.resolveAdmin(row);
        const entity = new AdminActivityLog();
        entity.changedFields = this.resolveChangedFields(row, baselines);
        entity.operationName = row.operationName;
        entity.entityType = row.entityType;
        entity.entityId = row.entityId;
        entity.targetCount = row.targetCount;
        entity.payload = row.payload;
        entity.outcome = row.outcome;
        entity.errorMessage = row.errorMessage;
        entity.adminId = resolved.adminId;
        entity.adminName = resolved.adminName;
        entity.sessionId = row.sessionId;
        entity.channelId = row.channelId;
        entity.ipAddress = row.ipAddress;
        entity.durationMs = row.durationMs;
        entity.isAuthEvent = row.isAuthEvent;
        return entity;
    }

    /**
     * Produces the changed-field list for one row, and promotes this row's
     * payload to be the baseline for any later row in the same batch touching the
     * same entity — otherwise two edits flushed together would both be measured
     * against the same older state, and the second would over-report.
     *
     * Skipped for creates, deletes, auth events and failed mutations. A create
     * changes every field by definition, a delete changes none, and a failed
     * mutation changed nothing at all — a field list on any of them would assert
     * something untrue.
     */
    private resolveChangedFields(
        row: PendingActivityRow,
        baselines: Map<string, Json>,
    ): string[] | null {
        if (row.isAuthEvent || row.outcome !== 'SUCCESS' || row.payload === null) {
            return null;
        }
        if (row.entityType === null || row.entityId === null) {
            return null;
        }
        if (/^(create|add|delete|remove)/i.test(row.operationName)) {
            return null;
        }
        const key = entityKey(row.entityType, row.entityId);
        const baseline = baselines.get(key);
        baselines.set(key, row.payload as Json);
        // The column stores paths only. The before/after values are NOT copied
        // here: both payloads are already rows in this table, so storing the
        // values again would be a third copy of the same bytes on every write,
        // to save one query on a page a human opens twice a week. The read side
        // re-derives them from the same diff.
        return toChangedPaths(baseline ? diffPayloads(baseline, row.payload as Json) : null);
    }

    private resolveAdmin(row: PendingActivityRow): ResolvedAdmin {
        if (row.userId === null) {
            return { adminId: null, adminName: row.fallbackAdminName ?? 'SYSTEM' };
        }
        const cached = this.adminCache.get(String(row.userId));
        if (cached) {
            return cached;
        }
        return { adminId: null, adminName: row.fallbackAdminName ?? `user:${String(row.userId)}` };
    }

    /**
     * Loads any administrators not yet cached. The administrator set is tiny and
     * effectively static, so after warmup this costs zero queries per flush —
     * which is what keeps the write path to one INSERT per interval.
     */
    private async warmAdminCache(userIds: ID[]): Promise<void> {
        const missing = [...new Set(userIds.map(String))].filter(id => !this.adminCache.has(id));
        if (missing.length === 0) {
            return;
        }
        const admins = await this.connection.rawConnection
            .getRepository(Administrator)
            .createQueryBuilder('administrator')
            .leftJoin('administrator.user', 'user')
            .addSelect('user.id')
            .where('user.id IN (:...ids)', { ids: missing })
            .withDeleted()
            .getMany();
        for (const admin of admins) {
            this.adminCache.set(String(admin.user.id), {
                adminId: admin.id,
                adminName: `${admin.firstName} ${admin.lastName}`.trim() || admin.emailAddress,
            });
        }
    }
}
