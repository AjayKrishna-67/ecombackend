import { Injectable } from '@nestjs/common';
import {
    ID,
    ListQueryBuilder,
    ListQueryOptions,
    PaginatedList,
    RequestContext,
    Session,
    TransactionalConnection,
} from '@vendure/core';
import { SelectQueryBuilder } from 'typeorm';
import { AdminActivityLog } from '../entities/admin-activity-log.entity';
import { diffPayloads } from './diff-payload';
import { resolveTarget } from './resolve-target';

type Json = Record<string, unknown>;

/**
 * Entities resolved per baseline query. Mirrors the writer's chunking for the
 * same reason: a page can name many distinct entities, and one enormous OR list
 * is the query shape that has taken this database down before.
 */
const ENTITY_CHUNK_SIZE = 50;

/** Composite lookup key for the (entityType, entityId) pair a row targets. */
function entityKey(entityType: string | null, entityId: string | null): string {
    return `${entityType ?? ''}::${entityId ?? ''}`;
}

/**
 * Whether a row can carry a field-level diff at all. Mirrors the writer's rule
 * exactly, because a row whose `changedFields` is null must not suddenly grow
 * values: a create changes every field by definition, a delete changes none, and
 * a failed mutation changed nothing at all.
 */
function isDiffable(row: AdminActivityLog): boolean {
    return (
        !row.isAuthEvent &&
        row.outcome === 'SUCCESS' &&
        row.payload !== null &&
        row.entityType !== null &&
        row.entityId !== null &&
        !/^(create|add|delete|remove)/i.test(row.operationName)
    );
}

export interface AdminSessionSummary {
    sessionId: string;
    adminId: ID | null;
    adminName: string;
    ipAddress: string | null;
    /** Raw UA string from the Session row; parsed into browser/OS/device by the UI. */
    userAgent: string | null;
    startedAt: Date;
    endedAt: Date;
    actionCount: number;
    errorCount: number;
    entityTypes: string[];
}

/**
 * Read side of the admin activity log.
 *
 * The session summary deliberately does NOT use `getManyAndCount()`. TypeORM
 * returns a wrong `totalItems` when the query has a GROUP BY — it counts grouped
 * rows as a scalar — so any paginated aggregate here uses a raw query plus a
 * separate COUNT over a subquery. Same trap that bit
 * `delivery-report.service.ts:170-183`.
 */
@Injectable()
export class AdminActivityLogService {
    constructor(
        private readonly connection: TransactionalConnection,
        private readonly listQueryBuilder: ListQueryBuilder,
    ) {}

    /**
     * Paginated activity rows. Flat and un-grouped, so the standard
     * ListQueryBuilder is safe here and gives the Dashboard its usual filter,
     * sort and pagination semantics for free.
     */
    async findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<AdminActivityLog>,
    ): Promise<PaginatedList<AdminActivityLog>> {
        const [items, totalItems] = await this.listQueryBuilder
            .build(AdminActivityLog, options, { ctx })
            .getManyAndCount();
        return { items: await this.enrich(ctx, items), totalItems };
    }

    /** Every recorded action against one entity, newest first. */
    async findForEntity(
        ctx: RequestContext,
        entityType: string,
        entityId: string,
        take = 100,
    ): Promise<AdminActivityLog[]> {
        const rows = await this.connection
            .getRepository(ctx, AdminActivityLog)
            .createQueryBuilder('log')
            .where('log.entityType = :entityType', { entityType })
            .andWhere('log.entityId = :entityId', { entityId })
            .orderBy('log.createdAt', 'DESC')
            .take(take)
            .getMany();
        return this.enrich(ctx, rows);
    }

    /** Every row belonging to one device session, newest first — the working-day timeline. */
    async findSessionTimeline(ctx: RequestContext, sessionId: string): Promise<AdminActivityLog[]> {
        const rows = await this.connection
            .getRepository(ctx, AdminActivityLog)
            .createQueryBuilder('log')
            .where('log.sessionId = :sessionId', { sessionId })
            .orderBy('log.createdAt', 'DESC')
            .getMany();
        return this.enrich(ctx, rows);
    }

    /**
     * Adds everything a row needs to be readable that is not stored on it.
     *
     * Three passes over the whole page, cheapest last: the device fingerprint
     * (one query), the before/after values (one query per 50 distinct entities),
     * then the target name and link (no query at all). Cost is a fixed couple of
     * queries however many rows came back — the same batching discipline the
     * user-agent lookup already established here.
     */
    private async enrich(
        ctx: RequestContext,
        rows: AdminActivityLog[],
    ): Promise<AdminActivityLog[]> {
        await this.attachUserAgents(ctx, rows);
        await this.attachChanges(ctx, rows);
        this.attachTargets(ctx, rows);
        return rows;
    }

    /**
     * Fills in each row's before/after values by re-running the same diff that
     * produced `changedFields`, this time against the payload of that row's
     * predecessor.
     *
     * Derived here rather than stored at write time because both payloads are
     * already rows in this table. Persisting the values would write a third copy
     * of the same bytes on every mutation, forever, to save one query on a page
     * a human opens twice a week — and it would leave every existing row without
     * values until someone backfilled them. Deriving costs one query, and works
     * on rows written long before this code existed.
     */
    private async attachChanges(ctx: RequestContext, rows: AdminActivityLog[]): Promise<void> {
        const diffable = rows.filter(row => isDiffable(row));
        if (diffable.length === 0) {
            return;
        }
        const previousById = await this.loadPreviousPayloads(ctx, diffable);
        for (const row of diffable) {
            const previous = previousById.get(String(row.id));
            row.changes = previous ? diffPayloads(previous, row.payload as Json) : null;
        }
    }

    private async loadPreviousPayloads(
        ctx: RequestContext,
        rows: AdminActivityLog[],
    ): Promise<Map<string, Json>> {
        const byEntity = new Map<string, AdminActivityLog[]>();
        for (const row of rows) {
            const key = entityKey(row.entityType, row.entityId);
            const bucket = byEntity.get(key);
            if (bucket) {
                bucket.push(row);
            } else {
                byEntity.set(key, [row]);
            }
        }
        const keys = [...byEntity.keys()];
        const previous = new Map<string, Json>();
        for (let start = 0; start < keys.length; start += ENTITY_CHUNK_SIZE) {
            const chunk = keys.slice(start, start + ENTITY_CHUNK_SIZE).flatMap(key => byEntity.get(key) ?? []);
            for (const [id, payload] of await this.loadPreviousChunk(ctx, chunk)) {
                previous.set(id, payload);
            }
        }
        return previous;
    }

    /**
     * Returns, for each supplied row, the payload of the row immediately before
     * it in its own entity's history.
     *
     * Expressed as a LAG window rather than a correlated `MAX(id)` subquery
     * because "the previous row" has to be resolved per ROW, not per entity. The
     * page is not the whole history: a session timeline shows one operator's
     * actions, and another operator's edit to the same product can sit between
     * two of them. Pairing consecutive rows within the page would silently
     * compare across that gap and report a change that spans two edits.
     *
     * `id <= :maxId` keeps the window off anything newer than the page, so a row
     * is always diffed against what came before it and never against a later
     * edit. MySQL 8.4 is the deployed server, so the window function is available.
     */
    private async loadPreviousChunk(
        ctx: RequestContext,
        rows: AdminActivityLog[],
    ): Promise<Map<string, Json>> {
        const targets = [
            ...new Map(rows.map(row => [entityKey(row.entityType, row.entityId), row])).values(),
        ];
        const rowIds = rows.map(row => String(row.id));
        const maxId = rowIds.reduce((max, id) => (Number(id) > Number(max) ? id : max), rowIds[0]);
        const pairs = targets.map(() => '(entityType = ? AND entityId = ?)').join(' OR ');
        const placeholders = rowIds.map(() => '?').join(', ');
        const sql = `
            SELECT ranked.id AS id, ranked.prevPayload AS prevPayload
            FROM (
                SELECT id, entityType, entityId,
                       LAG(payload) OVER (
                           PARTITION BY entityType, entityId ORDER BY id
                       ) AS prevPayload
                FROM admin_activity_log
                WHERE outcome = 'SUCCESS' AND payload IS NOT NULL AND id <= ?
                  AND (${pairs})
            ) ranked
            WHERE ranked.id IN (${placeholders}) AND ranked.prevPayload IS NOT NULL`;
        const params = [
            maxId,
            ...targets.flatMap(row => [row.entityType, row.entityId]),
            ...rowIds,
        ];
        const raw = await this.connection
            .getRepository(ctx, AdminActivityLog)
            .query(sql, params) as Array<{ id: number | string; prevPayload: string | null }>;
        const previous = new Map<string, Json>();
        for (const record of raw) {
            const parsed = parseJsonPayload(record.prevPayload);
            if (parsed !== null) {
                previous.set(String(record.id), parsed);
            }
        }
        return previous;
    }

    /**
     * Names each row's target and works out where clicking it should go.
     *
     * Costs no queries: the name comes from the row's own payload, which for
     * `updateProduct` and `updateProductVariant` already carries
     * `translations[].name`, and those two operations dominate this log.
     *
     * Rows whose payload holds no name — `setVariantTags` sends only
     * `{variantId, tagIds}` — borrow the name any OTHER row on the same page
     * found for the same entity. Still no query, and on a session timeline the
     * tagging almost always sits next to an edit of the variant it tagged.
     */
    private attachTargets(ctx: RequestContext, rows: AdminActivityLog[]): void {
        const languageCode = String(ctx.languageCode);
        const resolved = rows.map(row =>
            resolveTarget({
                entityType: row.entityType,
                entityId: row.entityId,
                payload: row.payload,
                languageCode,
            }),
        );
        const knownLabels = new Map<string, string>();
        rows.forEach((row, index) => {
            const label = resolved[index].label;
            const key = entityKey(row.entityType, row.entityId);
            if (label !== null && !knownLabels.has(key)) {
                knownLabels.set(key, label);
            }
        });
        rows.forEach((row, index) => {
            const key = entityKey(row.entityType, row.entityId);
            row.entityLink = resolved[index].link;
            row.entityLabel = resolved[index].label ?? knownLabels.get(key) ?? null;
        });
    }

    /**
     * Resolves each row's device fingerprint from its Session in ONE extra query.
     *
     * The user agent is stored once per session rather than copied onto every
     * action row, so reading it back needs a lookup. Doing that per row would be
     * a classic N+1 — a hundred-row product history would issue a hundred
     * queries — so distinct session ids are collected first and fetched in a
     * single `IN` query. Rows written before session ids were stored as the
     * Session primary key simply resolve nothing.
     */
    private async attachUserAgents(
        ctx: RequestContext,
        rows: AdminActivityLog[],
    ): Promise<AdminActivityLog[]> {
        const sessionIds = [...new Set(rows.map(row => row.sessionId).filter(Boolean))] as string[];
        if (sessionIds.length === 0) {
            return rows;
        }
        const sessions = await this.connection
            .getRepository(ctx, Session)
            .createQueryBuilder('sess')
            .select(['sess.id', 'sess.customFieldsUseragent'])
            .where('sess.id IN (:...sessionIds)', { sessionIds })
            .getRawMany<{ sess_id: number; sess_customFieldsUseragent: string | null }>();
        const byId = new Map(
            sessions.map(row => [String(row.sess_id), row.sess_customFieldsUseragent ?? null]),
        );
        for (const row of rows) {
            row.userAgent = row.sessionId ? (byId.get(row.sessionId) ?? null) : null;
        }
        return rows;
    }

    /**
     * One row per device session: who, from where, when they started and stopped,
     * and how much they touched.
     */
    async findSessions(
        ctx: RequestContext,
        options: { skip?: number; take?: number; adminId?: ID; since?: Date } = {},
    ): Promise<PaginatedList<AdminSessionSummary>> {
        const skip = options.skip ?? 0;
        // The Work Sessions page groups sessions by administrator in the browser,
        // so it needs the whole window rather than a page of it — paginating
        // sessions would split one person's devices across pages. The ceiling is
        // still low enough that the grouped result stays renderable, and the
        // window is bounded by `since` on the caller's side.
        const take = Math.min(options.take ?? 25, 500);
        const rows = await this.buildSessionQuery(ctx, options)
            .orderBy('startedAt', 'DESC')
            .offset(skip)
            .limit(take)
            .getRawMany();
        const totalItems = await this.countSessions(ctx, options);
        return { items: rows.map(row => this.toSessionSummary(row)), totalItems };
    }

    private buildSessionQuery(
        ctx: RequestContext,
        options: { adminId?: ID; since?: Date },
    ): SelectQueryBuilder<AdminActivityLog> {
        const qb = this.connection
            .getRepository(ctx, AdminActivityLog)
            .createQueryBuilder('log')
            .select('log.sessionId', 'sessionId')
            .addSelect('MIN(log.adminId)', 'adminId')
            .addSelect('MIN(log.adminName)', 'adminName')
            .addSelect('MIN(log.ipAddress)', 'ipAddress')
            .addSelect('MIN(log.createdAt)', 'startedAt')
            .addSelect('MAX(log.createdAt)', 'endedAt')
            .addSelect('COUNT(*)', 'actionCount')
            .addSelect("SUM(CASE WHEN log.outcome = 'ERROR' THEN 1 ELSE 0 END)", 'errorCount')
            .addSelect('GROUP_CONCAT(DISTINCT log.entityType)', 'entityTypes')
            // The device fingerprint lives on the Session row, not on the log
            // row, so it is stored once per session instead of duplicated onto
            // every action. `log.sessionId` holds the Session primary key, which
            // is what makes this join possible.
            .leftJoin(Session, 'sess', 'sess.id = log.sessionId')
            .addSelect('MIN(sess.customFieldsUseragent)', 'userAgent')
            .where('log.sessionId IS NOT NULL')
            .groupBy('log.sessionId');
        if (options.adminId !== undefined) {
            qb.andWhere('log.adminId = :adminId', { adminId: options.adminId });
        }
        if (options.since !== undefined) {
            qb.andWhere('log.createdAt >= :since', { since: options.since });
        }
        return qb;
    }

    /**
     * Counts distinct sessions with a scalar query rather than reading
     * `getManyAndCount()`'s total, which is wrong for grouped queries.
     */
    private async countSessions(
        ctx: RequestContext,
        options: { adminId?: ID; since?: Date },
    ): Promise<number> {
        const qb = this.connection
            .getRepository(ctx, AdminActivityLog)
            .createQueryBuilder('log')
            .select('COUNT(DISTINCT log.sessionId)', 'total')
            .where('log.sessionId IS NOT NULL');
        if (options.adminId !== undefined) {
            qb.andWhere('log.adminId = :adminId', { adminId: options.adminId });
        }
        if (options.since !== undefined) {
            qb.andWhere('log.createdAt >= :since', { since: options.since });
        }
        const result = await qb.getRawOne<{ total: string }>();
        return Number(result?.total ?? 0);
    }

    private toSessionSummary(row: Record<string, unknown>): AdminSessionSummary {
        return {
            sessionId: String(row.sessionId),
            adminId: (row.adminId as ID) ?? null,
            adminName: String(row.adminName ?? 'UNKNOWN'),
            ipAddress: (row.ipAddress as string) ?? null,
            userAgent: (row.userAgent as string) ?? null,
            startedAt: new Date(row.startedAt as string),
            endedAt: new Date(row.endedAt as string),
            actionCount: Number(row.actionCount ?? 0),
            errorCount: Number(row.errorCount ?? 0),
            entityTypes: String(row.entityTypes ?? '').split(',').filter(Boolean),
        };
    }
}

/**
 * Parses a payload column read through a raw query.
 *
 * TypeORM's `simple-json` transformer only runs when it hydrates an entity, so a
 * value pulled out by a window function arrives as the raw text it is stored as.
 * A row whose text will not parse is skipped rather than thrown on: a broken
 * baseline must cost that one row its values, never the whole page.
 */
function parseJsonPayload(value: string | null): Json | null {
    if (value === null) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Json)
            : null;
    } catch {
        return null;
    }
}
