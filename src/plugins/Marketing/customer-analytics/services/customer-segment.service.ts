import { Injectable } from '@nestjs/common';
import { ID, RequestContext, TransactionalConnection } from '@vendure/core';
import { classifyRecency, CustomerSegmentState, RecencyThresholds } from './classify-recency';

/** A single customer row within a recency segment. */
export interface CustomerSegmentRow {
    customerId: ID;
    firstName: string;
    lastName: string;
    emailAddress: string;
    lastOrderAt: Date | null;
    daysSinceLastOrder: number | null;
    state: CustomerSegmentState;
}

/**
 * A customer row enriched with the per-customer order aggregates needed for CSV export.
 * `totalOrderValue` is in minor units (paise/cents); the client divides by 100 for display.
 * `phoneNumber` is null when the customer has none on file.
 */
export interface CustomerSegmentExportRow extends CustomerSegmentRow {
    phoneNumber: string | null;
    orderCount: number;
    totalOrderValue: number;
}

/** Counts per recency bucket for the active channel. */
export interface CustomerSegmentSummary {
    active: number;
    atRisk: number;
    churn: number;
    never: number;
}

/** Pagination for the per-state list. */
export interface CustomerSegmentListOptions {
    skip?: number;
    take?: number;
}

const DEFAULT_TAKE = 25;
const MAX_TAKE = 100;
const EXPORT_CAP = 50_000;
const EXCLUDED_STATE = 'Cancelled';

type SqlParam = string | number | ID;

/**
 * Computes recency segments live from the order table (indexed; the per-customer order
 * aggregate is a single GROUP BY pass LEFT JOINed on customerId, not a correlated subquery
 * re-evaluated per customer row).
 *
 * Scope:
 *   - customers: only those in the active channel (customer_channels_channel), enforced via
 *                EXISTS on the OUTER query so Never-ordered customers are kept.
 *   - orders:    only orderPlacedAt-set, non-Cancelled, in the active channel.
 *
 * Why the LEFT JOIN is safe: the joined subquery is already GROUP BY customerId, so it yields
 * exactly one row per customer (no row multiplication), and LEFT JOIN preserves customers with
 * no qualifying order as NEVER (agg.lastOrderAt NULL). Those are the two failure modes a raw
 * JOIN on the order table would cause. `getManyAndCount()` stays unusable (broken with GROUP BY
 * / derived columns), so counts and the list come from raw parameterized SQL with a separate COUNT.
 *
 * Param ordering rule: placeholders bind in SQL-text order. The derived sub-SELECT
 * (`derivedTable`) carries [channelId (agg JOIN), EXCLUDED_STATE (agg WHERE), channelId (outer
 * EXISTS)]. The outer SELECT's threshold placeholders (summary) precede the FROM, so they bind
 * first; the WHERE bucket placeholders (list/count) follow the FROM, so they bind after.
 */
@Injectable()
export class CustomerSegmentService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Per-customer derived table: customerId + optional extra columns + lastOrderAt
     * (MAX qualifying orderPlacedAt, NULL ⇒ Never-ordered). Channel-scoped on both
     * the order subquery and the customer base.
     */
    private derivedTable(extraCols: string): string {
        return `(SELECT c.id AS customerId${extraCols}, agg.lastOrderAt AS lastOrderAt
                 FROM customer c
                 LEFT JOIN (SELECT o.customerId AS customerId, MAX(o.orderPlacedAt) AS lastOrderAt
                            FROM \`order\` o
                            JOIN order_channels_channel occ ON occ.orderId = o.id AND occ.channelId = ?
                            WHERE o.orderPlacedAt IS NOT NULL AND o.state <> ?
                            GROUP BY o.customerId) agg ON agg.customerId = c.id
                 WHERE c.deletedAt IS NULL
                   AND EXISTS (SELECT 1 FROM customer_channels_channel ccc
                               WHERE ccc.customerId = c.id AND ccc.channelId = ?)) t`;
    }

    /** Params the derived table binds, in SQL-text order (agg JOIN, agg WHERE, outer EXISTS). */
    private derivedParams(ctx: RequestContext): SqlParam[] {
        return [ctx.channelId, EXCLUDED_STATE, ctx.channelId];
    }

    /**
     * Export-only derived table. Order aggregates (MAX orderPlacedAt, COUNT, SUM money) come
     * from ONE pre-grouped subquery scanned a single time, then LEFT JOINed per customer — not
     * three correlated subqueries re-evaluated per row. The channel filter lives INSIDE the
     * grouped subquery (inner JOIN on order_channels_channel, one row per order so COUNT/SUM
     * don't multiply), and the LEFT JOIN preserves order-less customers as the NEVER bucket
     * (agg columns NULL).
     *
     * Money is summed ONLY for orders in the channel's reporting currency (the CASE on
     * currencyCode), so a multi-currency channel never sums INR + USD into one nonsense total.
     * lastOrderAt and orderCount stay over ALL qualifying orders so the recency bucket and the
     * order count match what the summary/list views show — only the value column is currency-scoped.
     *
     * Param order: currencyCode (SUM CASE, first in the SELECT list), channelId (agg JOIN),
     * EXCLUDED_STATE (agg WHERE), channelId (outer customer-in-channel EXISTS).
     */
    private exportDerivedTable(): string {
        return `(SELECT c.id AS customerId, c.firstName, c.lastName, c.emailAddress, c.phoneNumber,
                    agg.lastOrderAt AS lastOrderAt,
                    agg.orderCount AS orderCount,
                    agg.totalOrderValue AS totalOrderValue
                 FROM customer c
                 LEFT JOIN (SELECT o.customerId AS customerId,
                                   MAX(o.orderPlacedAt) AS lastOrderAt,
                                   COUNT(*) AS orderCount,
                                   SUM(CASE WHEN o.currencyCode = ?
                                            THEN o.subTotalWithTax + o.shippingWithTax
                                            ELSE 0 END) AS totalOrderValue
                            FROM \`order\` o
                            JOIN order_channels_channel occ ON occ.orderId = o.id AND occ.channelId = ?
                            WHERE o.orderPlacedAt IS NOT NULL AND o.state <> ?
                            GROUP BY o.customerId) agg ON agg.customerId = c.id
                 WHERE c.deletedAt IS NULL
                   AND EXISTS (SELECT 1 FROM customer_channels_channel ccc
                               WHERE ccc.customerId = c.id AND ccc.channelId = ?)) t`;
    }

    /** Params the export derived table binds, in SQL-text order (SUM currency, agg JOIN, agg WHERE, outer EXISTS). */
    private exportDerivedParams(ctx: RequestContext): SqlParam[] {
        return [ctx.channel.defaultCurrencyCode, ctx.channelId, EXCLUDED_STATE, ctx.channelId];
    }

    /** Returns the four bucket counts for the active channel in one pass. */
    async computeSummary(ctx: RequestContext, thresholds: RecencyThresholds): Promise<CustomerSegmentSummary> {
        const { activeWithinDays: x, atRiskUntilDays: y } = thresholds;
        const days = `DATEDIFF(UTC_TIMESTAMP(), t.lastOrderAt)`;
        const sql = `SELECT
                SUM(CASE WHEN t.lastOrderAt IS NOT NULL AND ${days} <= ? THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN ${days} > ? AND ${days} <= ? THEN 1 ELSE 0 END) AS atRisk,
                SUM(CASE WHEN ${days} > ? THEN 1 ELSE 0 END) AS churn,
                SUM(CASE WHEN t.lastOrderAt IS NULL THEN 1 ELSE 0 END) AS \`never\`
            FROM ${this.derivedTable('')}`;
        const params: SqlParam[] = [x, x, y, y, ...this.derivedParams(ctx)];
        const rows = await this.connection.rawConnection.query(sql, params);
        const row = rows?.[0] ?? {};
        return {
            active: this.toInt(row.active),
            atRisk: this.toInt(row.atRisk),
            churn: this.toInt(row.churn),
            never: this.toInt(row.never),
        };
    }

    /** Returns one bucket's customers, paginated, newest-lapsed first. */
    async listByState(
        ctx: RequestContext,
        state: CustomerSegmentState,
        thresholds: RecencyThresholds,
        options: CustomerSegmentListOptions = {},
    ): Promise<{ items: CustomerSegmentRow[]; totalItems: number }> {
        const take = Math.min(options.take ?? DEFAULT_TAKE, MAX_TAKE);
        const skip = options.skip ?? 0;
        const totalItems = await this.countByState(ctx, state, thresholds);
        const items = await this.selectByState(ctx, state, thresholds, take, skip);
        return { items, totalItems };
    }

    /** Returns ALL customer ids in a bucket (capped) for export / save-as-group. */
    async listCustomerIds(
        ctx: RequestContext,
        state: CustomerSegmentState,
        thresholds: RecencyThresholds,
    ): Promise<ID[]> {
        const rows = await this.selectByState(ctx, state, thresholds, EXPORT_CAP, 0);
        return rows.map(row => row.customerId);
    }

    /**
     * Returns ALL customers in a bucket (capped at EXPORT_CAP) enriched with phone, order
     * count and total order value — the full row set for a CSV export. Uses its own derived
     * table (three correlated order subqueries: MAX lastOrderAt, COUNT, SUM totalWithTax) so
     * the heavier aggregates never run on the hot paginated list path.
     */
    async exportByState(
        ctx: RequestContext,
        state: CustomerSegmentState,
        thresholds: RecencyThresholds,
    ): Promise<CustomerSegmentExportRow[]> {
        const order = state === 'NEVER' ? 't.customerId ASC' : 't.lastOrderAt ASC';
        const sql = `SELECT t.customerId, t.firstName, t.lastName, t.emailAddress, t.phoneNumber,
                t.lastOrderAt, t.orderCount, t.totalOrderValue,
                CASE WHEN t.lastOrderAt IS NULL THEN NULL ELSE DATEDIFF(UTC_TIMESTAMP(), t.lastOrderAt) END AS daysSinceLastOrder
            FROM ${this.exportDerivedTable()}
            WHERE ${this.bucketPredicate(state)}
            ORDER BY ${order} LIMIT ?`;
        const params = [
            ...this.exportDerivedParams(ctx),
            ...this.bucketThresholds(state, thresholds),
            EXPORT_CAP,
        ];
        const rows = await this.connection.rawConnection.query(sql, params);
        return rows.map((row: Record<string, unknown>) => this.toExportRow(row, thresholds));
    }

    private async countByState(
        ctx: RequestContext,
        state: CustomerSegmentState,
        thresholds: RecencyThresholds,
    ): Promise<number> {
        const sql = `SELECT COUNT(*) AS total FROM ${this.derivedTable('')} WHERE ${this.bucketPredicate(state)}`;
        const params = [...this.derivedParams(ctx), ...this.bucketThresholds(state, thresholds)];
        const rows = await this.connection.rawConnection.query(sql, params);
        return this.toInt(rows?.[0]?.total);
    }

    private async selectByState(
        ctx: RequestContext,
        state: CustomerSegmentState,
        thresholds: RecencyThresholds,
        take: number,
        skip: number,
    ): Promise<CustomerSegmentRow[]> {
        const order = state === 'NEVER' ? 't.customerId ASC' : 't.lastOrderAt ASC';
        const sql = `SELECT t.customerId, t.firstName, t.lastName, t.emailAddress, t.lastOrderAt,
                CASE WHEN t.lastOrderAt IS NULL THEN NULL ELSE DATEDIFF(UTC_TIMESTAMP(), t.lastOrderAt) END AS daysSinceLastOrder
            FROM ${this.derivedTable(', c.firstName, c.lastName, c.emailAddress')}
            WHERE ${this.bucketPredicate(state)}
            ORDER BY ${order} LIMIT ? OFFSET ?`;
        const params = [...this.derivedParams(ctx), ...this.bucketThresholds(state, thresholds), take, skip];
        const rows = await this.connection.rawConnection.query(sql, params);
        return rows.map((row: Record<string, unknown>) => this.toRow(row, thresholds));
    }

    /** SQL predicate selecting a single bucket from the derived `t.lastOrderAt`. */
    private bucketPredicate(state: CustomerSegmentState): string {
        const days = `DATEDIFF(UTC_TIMESTAMP(), t.lastOrderAt)`;
        switch (state) {
            case 'NEVER':
                return 't.lastOrderAt IS NULL';
            case 'ACTIVE':
                return `t.lastOrderAt IS NOT NULL AND ${days} <= ?`;
            case 'AT_RISK':
                return `${days} > ? AND ${days} <= ?`;
            case 'CHURN':
                return `${days} > ?`;
        }
    }

    /** Threshold params for `bucketPredicate`, in SQL-text order. */
    private bucketThresholds(state: CustomerSegmentState, thresholds: RecencyThresholds): number[] {
        const { activeWithinDays: x, atRiskUntilDays: y } = thresholds;
        switch (state) {
            case 'NEVER':
                return [];
            case 'ACTIVE':
                return [x];
            case 'AT_RISK':
                return [x, y];
            case 'CHURN':
                return [y];
        }
    }

    private toRow(row: Record<string, unknown>, thresholds: RecencyThresholds): CustomerSegmentRow {
        const lastOrderAt = row.lastOrderAt ? new Date(row.lastOrderAt as string) : null;
        const daysSinceLastOrder =
            row.daysSinceLastOrder === null || row.daysSinceLastOrder === undefined
                ? null
                : Number(row.daysSinceLastOrder);
        return {
            customerId: row.customerId as ID,
            firstName: (row.firstName as string) ?? '',
            lastName: (row.lastName as string) ?? '',
            emailAddress: (row.emailAddress as string) ?? '',
            lastOrderAt,
            daysSinceLastOrder,
            state: classifyRecency(daysSinceLastOrder, thresholds),
        };
    }

    private toExportRow(row: Record<string, unknown>, thresholds: RecencyThresholds): CustomerSegmentExportRow {
        const base = this.toRow(row, thresholds);
        const phoneRaw = row.phoneNumber;
        return {
            ...base,
            phoneNumber: phoneRaw === null || phoneRaw === undefined ? null : String(phoneRaw),
            orderCount: this.toInt(row.orderCount),
            totalOrderValue: this.toInt(row.totalOrderValue),
        };
    }

    private toInt(value: unknown): number {
        const parsed = parseInt(String(value ?? '0'), 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
}
