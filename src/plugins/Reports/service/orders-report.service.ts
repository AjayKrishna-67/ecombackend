import { Injectable } from '@nestjs/common';
import { CacheService, ID, Logger, Order, OrderStateMachine, Promotion, RequestContext, TransactionalConnection } from '@vendure/core';
import { In } from 'typeorm';

import { billLineAmounts } from './bill-line-amounts';

const loggerCtx = 'OrdersReportService';

const DEFAULT_TAKE = 100;
const MAX_TAKE = 1000;

const REPORTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — reports are historical aggregates; invalidateAllReports() forces freshness on data changes
const REPORTS_TAG_ALL = 'reports:all';

// Hard cap (ms) for any single report SELECT. On overrun MySQL aborts the
// statement (ER_QUERY_TIMEOUT, errno 3024) and RETURNS THE CONNECTION TO THE
// POOL — so a runaway report frees its slot instead of pinning RDS CPU and
// exhausting the connection pool. Delivered via the MAX_EXECUTION_TIME optimizer
// hint (raw SQL) / QueryBuilder.maxExecutionTime() — purely additive, changes
// zero rows, and is ignored by MySQL versions that don't support it.
const REPORTS_QUERY_TIMEOUT_MS = 15_000;
const MET_HINT = `/*+ MAX_EXECUTION_TIME(${REPORTS_QUERY_TIMEOUT_MS}) */`;

function cacheKeyFromInput(prefix: string, channelId: ID, input: Record<string, any>): string {
    // Stable JSON: sort keys so the same logical input always produces the same key.
    const sorted = Object.keys(input)
        .sort()
        .reduce<Record<string, any>>((acc, k) => {
            const v = input[k];
            if (v === undefined) return acc;
            if (v instanceof Date) acc[k] = v.toISOString();
            else if (Array.isArray(v)) acc[k] = [...v].sort();
            else acc[k] = v;
            return acc;
        }, {});
    return `reports:${prefix}:ch${channelId}:${JSON.stringify(sorted)}`;
}

function reviveDate(v: unknown): Date | null {
    if (v == null) return null;
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

export interface DeliveredOrdersReportInput {
    from: Date;
    to: Date;
    channelIds?: ID[];
    skip?: number;
    take?: number;
}

export interface DeliveredOrdersReportRow {
    orderCode: string;
    orderStatus: string;
    orderAmount: number;
    netAmount: number;
    orderPlacedAt: Date | null;
    deliveredAt: Date;
    channelId: ID;
    channelCode: string;
}

export interface DeliveredOrdersReport {
    items: DeliveredOrdersReportRow[];
    totalItems: number;
    totalOrderAmount: number;
    totalNetAmount: number;
}

export interface SalesReportInput {
    from: Date;
    to: Date;
    channelIds?: ID[];
    skip?: number;
    take?: number;
}

export interface SalesReportRow {
    orderCode: string;
    orderStatus: string;
    invoiceNo: string | null;
    orderAmount: number;
    netAmount: number;
    orderPlacedAt: Date | null;
    deliveredAt: Date | null;
    channelId: ID;
    channelCode: string;
}

export interface SalesReport {
    items: SalesReportRow[];
    totalItems: number;
    totalOrderAmount: number;
    totalNetAmount: number;
}

export interface MonthlyProductSalesReportInput {
    from: Date;
    to: Date;
    channelIds?: ID[];
    facetIds?: ID[];
    facetIdFrom?: ID;
    facetIdTo?: ID;
    skip?: number;
    take?: number;
}

export interface MonthlyProductFacetSummary {
    id: ID;
    name: string;
}

export interface MonthlyProductSalesReportRow {
    productId: ID;
    productName: string;
    /** Facet values the product belongs to. When the input facet filter is
     *  active, only matching facets are listed; otherwise every facet the
     *  product belongs to. The frontend joins these into a comma-separated
     *  display string and also reuses the IDs to populate the filter
     *  dropdown. */
    facets: MonthlyProductFacetSummary[];
    totalQuantitySold: number;
    totalSalesAmount: number;
}

export interface MonthlyProductSalesReport {
    items: MonthlyProductSalesReportRow[];
    totalItems: number;
    totalQuantitySold: number;
    totalSalesAmount: number;
}

export interface BillPrintReportInput {
    from: Date;
    to: Date;
    channelIds?: ID[];
    states?: string[];
    skip?: number;
    take?: number;
}

export interface BillPrintReportRow {
    id: ID;
    pCode: string | null;
    sNo: string;
    code: string;
    date: string | null;
    time: string | null;
    billingAddress: string | null;
    customer: string;
    address: string;
    cellNo: string;
    itemName: string;
    tamilName: string;
    qty: number;
    shadowPrice: number | null;
    rate: number;
    total: number;
    subTotal: number;
    shipping: number;
    netTotal: number;
    deliveryTime: string | null;
    cuttingInstructions: string | null;
    paymentMode: string;
    ordNo: number;
    customerId: ID | null;
    pincode: string;
    paymentMetadata: string | null;
    paymentMethod: string | null;
    paymentStatus: string;
    rewardPointUsed: number | null;
    couponCode: string | null;
    note: string | null;
    orderModifyNote: string | null;
    invoiceNo: string;
    couponDiscount: number;
    rewardDiscount: number;
    originalShipping: number;
    discounts: BillPrintDiscount[];
    loyaltyPointsUsed: number | null;
    loyaltyPointsAvailable: number | null;
    paymentType: BillPaymentType;
    adminMarkedAsPaid: boolean;
    hsnCode: string | null;
    taxRate: number;
    taxAmount: number;
    priceBeforeTax: number;
    totalTaxAmount: number;
    /** Line total after item-level coupon discounts (free product, product %), incl. tax. */
    discountedTotal: number | null;
    /** A coupon gift product the customer pays nothing for. */
    isFree: boolean | null;
}

export type BillPaymentType = 'ONLINE' | 'COD';

/** Per-line figures loaded from the Order entity for bill-print rows. */
interface BillLineInfo {
    taxRate: number;
    taxAmount: number;
    priceBeforeTax: number;
    hsnCode: string | null;
    discountedTotal: number;
    isFree: boolean;
}

export interface BillPrintDiscount {
    description: string;
    code: string | null;
    source: string;
    amount: number;
}

export interface BillPrintReport {
    items: BillPrintReportRow[];
    totalItems: number;
}

@Injectable()
export class OrdersReportService {
    constructor(
        private readonly connection: TransactionalConnection,
        private readonly cacheService: CacheService,
        private readonly orderStateMachine: OrderStateMachine,
    ) {}

    getAvailableOrderStates(): string[] {
        return Object.keys(this.orderStateMachine.config.transitions);
    }

    // Per-pod coalescing of concurrent identical report computes. A burst of N
    // identical requests (the pattern that exhausted the connection pool) shares
    // ONE DB execution instead of firing N. Entries are deleted on settle, so a
    // failed/timed-out compute is retried by the next caller, never poisoned.
    private readonly inFlightReports = new Map<string, Promise<any>>();

    private async getOrCompute<T>(
        cacheKey: string,
        compute: () => Promise<T>,
        revive?: (cached: any) => T,
    ): Promise<T> {
        const cached = await this.cacheService.get(cacheKey);
        if (cached !== undefined) {
            Logger.debug(`[OrdersReport] Cache hit: ${cacheKey}`, loggerCtx);
            return revive ? revive(cached) : (cached as T);
        }

        // Coalesce concurrent identical misses into a single compute + DB hit.
        const existing = this.inFlightReports.get(cacheKey) as Promise<T> | undefined;
        if (existing) {
            Logger.debug(`[OrdersReport] Coalesced in-flight: ${cacheKey}`, loggerCtx);
            const shared = await existing;
            return revive ? revive(shared) : shared;
        }

        const promise = (async () => {
            const result = await compute();
            await this.cacheService.set(cacheKey, result as any, {
                ttl: REPORTS_CACHE_TTL_MS,
                tags: [REPORTS_TAG_ALL],
            });
            return result;
        })();
        this.inFlightReports.set(cacheKey, promise);
        try {
            const result = await promise;
            return revive ? revive(result) : result;
        } finally {
            this.inFlightReports.delete(cacheKey);
        }
    }

    /** Invalidate every cached report. Call after data-changing admin operations if you need fresh reports. */
    async invalidateAllReports(): Promise<void> {
        await this.cacheService.invalidateTags([REPORTS_TAG_ALL]);
        Logger.info('[OrdersReport] All cached reports invalidated', loggerCtx);
    }

    async getDeliveredOrdersReport(
        ctx: RequestContext,
        input: DeliveredOrdersReportInput,
    ): Promise<DeliveredOrdersReport> {
        const { from, to, skip, take } = this.normalizePagination(input);
        const channelIds = this.resolveChannelIds(ctx, input.channelIds);

        const cacheKey = cacheKeyFromInput('deliveredOrders', ctx.channelId, {
            from, to, skip, take, channelIds,
        });

        return this.getOrCompute<DeliveredOrdersReport>(
            cacheKey,
            () => this.computeDeliveredOrdersReport(ctx, from, to, channelIds, skip, take),
            (cached: any) => ({
                ...cached,
                items: (cached.items as any[]).map(r => ({
                    ...r,
                    orderPlacedAt: reviveDate(r.orderPlacedAt),
                    deliveredAt: reviveDate(r.deliveredAt) as Date,
                })),
            }),
        );
    }

    private async computeDeliveredOrdersReport(
        ctx: RequestContext,
        from: Date,
        to: Date,
        channelIds: ID[],
        skip: number,
        take: number,
    ): Promise<DeliveredOrdersReport> {
        Logger.info(
            `deliveredOrdersReport from=${from.toISOString()} to=${to.toISOString()} channels=${channelIds.join(
                ',',
            )} skip=${skip} take=${take}`,
            loggerCtx,
        );

        const rowsSql = `
            SELECT ${MET_HINT}
                o.code                                        AS orderCode,
                o.state                                       AS orderStatus,
                o.subTotalWithTax                             AS orderAmount,
                (o.subTotalWithTax + o.shippingWithTax)       AS netAmount,
                o.orderPlacedAt                               AS orderPlacedAt,
                o.updatedAt                                   AS deliveredAt,
                ch.id                                         AS channelId,
                ch.code                                       AS channelCode
            FROM \`order\` o
            INNER JOIN order_channels_channel occ ON occ.orderId = o.id
            INNER JOIN channel ch ON ch.id = occ.channelId
            WHERE o.state = 'Delivered'
              AND o.updatedAt BETWEEN ? AND ?
              AND occ.channelId IN (?)
            ORDER BY o.updatedAt ASC, o.code ASC
            LIMIT ? OFFSET ?
        `;

        const countSql = `
            SELECT ${MET_HINT} COUNT(*) AS total
            FROM \`order\` o
            INNER JOIN order_channels_channel occ ON occ.orderId = o.id
            WHERE o.state = 'Delivered'
              AND o.updatedAt BETWEEN ? AND ?
              AND occ.channelId IN (?)
        `;

        const totalsSql = `
            SELECT ${MET_HINT}
                COALESCE(SUM(o.subTotalWithTax), 0)                     AS totalOrderAmount,
                COALESCE(SUM(o.subTotalWithTax + o.shippingWithTax), 0) AS totalNetAmount
            FROM \`order\` o
            INNER JOIN order_channels_channel occ ON occ.orderId = o.id
            WHERE o.state = 'Delivered'
              AND o.updatedAt BETWEEN ? AND ?
              AND occ.channelId IN (?)
        `;

        const db = this.connection.rawConnection;

        const [rows, countRows, totalsRows] = await Promise.all([
            db.query(rowsSql, [from, to, channelIds, take, skip]) as Promise<any[]>,
            db.query(countSql, [from, to, channelIds]) as Promise<Array<{ total: number | string }>>,
            db.query(totalsSql, [from, to, channelIds]) as Promise<
                Array<{ totalOrderAmount: number | string; totalNetAmount: number | string }>
            >,
        ]);

        const items: DeliveredOrdersReportRow[] = rows.map(r => ({
            orderCode: r.orderCode,
            orderStatus: r.orderStatus,
            orderAmount: Number(r.orderAmount),
            netAmount: Number(r.netAmount),
            orderPlacedAt: r.orderPlacedAt ? new Date(r.orderPlacedAt) : null,
            deliveredAt: new Date(r.deliveredAt),
            channelId: r.channelId,
            channelCode: r.channelCode,
        }));

        return {
            items,
            totalItems: Number(countRows[0]?.total ?? 0),
            totalOrderAmount: Number(totalsRows[0]?.totalOrderAmount ?? 0),
            totalNetAmount: Number(totalsRows[0]?.totalNetAmount ?? 0),
        };
    }

    async getSalesReport(ctx: RequestContext, input: SalesReportInput): Promise<SalesReport> {
        const { from, to, skip, take } = this.normalizePagination(input);
        const channelIds = this.resolveChannelIds(ctx, input.channelIds);

        // 'sales-v5' bumps the cache namespace after redefining the report as
        // COMPLETED sales: orders in the Delivered state, filtered by the date
        // the order was placed (o.orderPlacedAt), scoped to the channel. Old
        // cached results (v4 = pending-to-deliver workload) would otherwise leak
        // the previous numbers back to clients.
        const cacheKey = cacheKeyFromInput('sales-v5', ctx.channelId, {
            from, to, skip, take, channelIds,
        });

        return this.getOrCompute<SalesReport>(
            cacheKey,
            () => this.computeSalesReport(ctx, from, to, channelIds, skip, take),
            (cached: any) => ({
                ...cached,
                items: (cached.items as any[]).map(r => ({
                    ...r,
                    orderPlacedAt: reviveDate(r.orderPlacedAt),
                    deliveredAt: reviveDate(r.deliveredAt),
                })),
            }),
        );
    }

    private async computeSalesReport(
        ctx: RequestContext,
        from: Date,
        to: Date,
        channelIds: ID[],
        skip: number,
        take: number,
    ): Promise<SalesReport> {
        Logger.info(
            `salesReport from=${from.toISOString()} to=${to.toISOString()} channels=${channelIds.join(
                ',',
            )} skip=${skip} take=${take}`,
            loggerCtx,
        );

        // Sales report = COMPLETED sales for the channel: orders in the Delivered
        // state, filtered by the date the order was PLACED (o.orderPlacedAt), one
        // row per (order × channel). This is a record of delivered business, not
        // the pending-delivery workload.
        //
        // - orderPlacedAt IS NOT NULL drops active carts (AddingItems /
        //   ArrangingPayment) and Drafts that were never actually placed.
        // - o.state = 'Delivered' keeps only orders that have been delivered.
        //
        // Delivery timestamp (customFieldsDeliveredat) is surfaced per row for
        // display via a LEFT JOIN to the order's Delivered fulfillment(s). The
        // Order → OrderLine → OrderLineReference → Fulfillment join multiplies
        // rows, so we collapse back to one row per (order × channel) with GROUP BY
        // and take MAX(f.customFieldsDeliveredat).
        const buildBaseQb = () =>
            this.connection
                .getRepository(ctx, 'Order')
                .createQueryBuilder('o')
                .innerJoin('order_channels_channel', 'occ', 'occ.orderId = o.id')
                .innerJoin('channel', 'ch', 'ch.id = occ.channelId')
                .leftJoin('order_line', 'ol', 'ol.orderId = o.id')
                .leftJoin(
                    'order_line_reference',
                    'olr',
                    `olr.orderLineId = ol.id AND olr.discriminator = 'FulfillmentLine'`,
                )
                .leftJoin(
                    'fulfillment',
                    'f',
                    `f.id = olr.fulfillmentId AND f.state = 'Delivered'`,
                )
                .where('o.orderPlacedAt IS NOT NULL')
                .andWhere('o.orderPlacedAt >= :from', { from })
                .andWhere('o.orderPlacedAt <= :to', { to })
                .andWhere('o.state = :deliveredState', { deliveredState: 'Delivered' })
                .andWhere('occ.channelId IN (:...channelIds)', { channelIds });

        // Page of rows for the current skip/take, grouped one per (order × channel).
        const rowsQb = buildBaseQb()
            .select('o.code', 'orderCode')
            .addSelect('o.state', 'orderStatus')
            .addSelect('o.customFieldsInvoiceno', 'invoiceNo')
            .addSelect('o.subTotalWithTax', 'orderAmount')
            .addSelect('(o.subTotalWithTax + o.shippingWithTax)', 'netAmount')
            .addSelect('o.orderPlacedAt', 'orderPlacedAt')
            .addSelect('MAX(f.customFieldsDeliveredat)', 'deliveredAt')
            .addSelect('ch.id', 'channelId')
            .addSelect('ch.code', 'channelCode')
            .groupBy('o.id')
            .addGroupBy('ch.id')
            .orderBy('o.orderPlacedAt', 'ASC')
            .addOrderBy('o.code', 'ASC')
            .offset(skip)
            .limit(take)
            .maxExecutionTime(REPORTS_QUERY_TIMEOUT_MS);

        // Distinct (order × channel) tuples with their per-order amounts.
        // Used to derive both `totalItems` (row count) and the SUM totals
        // in JS — avoids the need for raw subquery-wrapped COUNT/SUM SQL.
        // For the typical month (~500 orders) this is a few hundred small
        // rows; switch to subquery-based aggregation if call sites ever
        // request windows in the tens-of-thousands range.
        const distinctTuplesQb = buildBaseQb()
            .select('o.id', 'oid')
            .addSelect('ch.id', 'chid')
            .addSelect('o.subTotalWithTax', 'orderAmount')
            .addSelect('(o.subTotalWithTax + o.shippingWithTax)', 'netAmount')
            .groupBy('o.id')
            .addGroupBy('ch.id')
            .addGroupBy('o.subTotalWithTax')
            .addGroupBy('o.shippingWithTax')
            .maxExecutionTime(REPORTS_QUERY_TIMEOUT_MS);

        const [rows, distinctTuples] = await Promise.all([
            rowsQb.getRawMany(),
            distinctTuplesQb.getRawMany<{
                oid: string;
                chid: string;
                orderAmount: number | string;
                netAmount: number | string;
            }>(),
        ]);

        const items: SalesReportRow[] = rows.map(r => ({
            orderCode: r.orderCode,
            orderStatus: r.orderStatus,
            invoiceNo: r.invoiceNo ?? null,
            orderAmount: Number(r.orderAmount),
            netAmount: Number(r.netAmount),
            orderPlacedAt: r.orderPlacedAt ? new Date(r.orderPlacedAt) : null,
            deliveredAt: r.deliveredAt ? new Date(r.deliveredAt) : null,
            channelId: r.channelId,
            channelCode: r.channelCode,
        }));

        const totalItems = distinctTuples.length;
        const totalOrderAmount = distinctTuples.reduce((sum, r) => sum + Number(r.orderAmount), 0);
        const totalNetAmount = distinctTuples.reduce((sum, r) => sum + Number(r.netAmount), 0);

        return {
            items,
            totalItems,
            totalOrderAmount,
            totalNetAmount,
        };
    }

    async getMonthlyProductSalesReport(
        ctx: RequestContext,
        input: MonthlyProductSalesReportInput,
    ): Promise<MonthlyProductSalesReport> {
        const { from, to, skip, take } = this.normalizePagination(input);
        const channelIds = this.resolveChannelIds(ctx, input.channelIds);
        const { facetIdFrom, facetIdTo } = input;
        const facetIds = input.facetIds && input.facetIds.length > 0 ? input.facetIds : undefined;

        const cacheKey = cacheKeyFromInput('monthlyProductSales', ctx.channelId, {
            from, to, skip, take, channelIds, facetIds, facetIdFrom, facetIdTo,
        });

        return this.getOrCompute<MonthlyProductSalesReport>(
            cacheKey,
            () => this.computeMonthlyProductSalesReport(ctx, from, to, channelIds, facetIds, facetIdFrom, facetIdTo, skip, take),
        );
    }

    private async computeMonthlyProductSalesReport(
        ctx: RequestContext,
        from: Date,
        to: Date,
        channelIds: ID[],
        facetIds: ID[] | undefined,
        facetIdFrom: ID | undefined,
        facetIdTo: ID | undefined,
        skip: number,
        take: number,
    ): Promise<MonthlyProductSalesReport> {
        Logger.info(
            `monthlyProductSalesReport from=${from.toISOString()} to=${to.toISOString()} channels=${channelIds.join(
                ',',
            )} facetIds=${facetIds ? facetIds.join(',') : 'null'} facetIdFrom=${
                facetIdFrom ?? 'null'
            } facetIdTo=${facetIdTo ?? 'null'} skip=${skip} take=${take}`,
            loggerCtx,
        );

        // facetIds takes precedence over the legacy range filter — a multi-select
        // can't be expressed as a contiguous range, so if the caller sent a list
        // the range is ignored. Empty list ([]) is treated as "no filter".
        const facetClauseParts: string[] = [];
        const facetParams: any[] = [];
        if (facetIds) {
            facetClauseParts.push('AND fv.id IN (?)');
            facetParams.push(facetIds);
        } else {
            if (facetIdFrom !== undefined && facetIdFrom !== null) {
                facetClauseParts.push('AND fa.id >= ?');
                facetParams.push(facetIdFrom);
            }
            if (facetIdTo !== undefined && facetIdTo !== null) {
                facetClauseParts.push('AND fa.id <= ?');
                facetParams.push(facetIdTo);
            }
        }
        const facetClause = facetClauseParts.join('\n                ');

        // One row per PRODUCT (not per facet). Earlier shape grouped by
        // (facet × product), which fanned products with N matching facets
        // into N rows and inflated the unfiltered totals by N×. Pomegranate
        // tagged both "Fruits" and "Saraswathi Pooja Special" showed up
        // twice with quantity 1 each → grand total quantity 2 for one sold
        // unit, etc. To fix without losing the facet column, we:
        //   1. Pre-aggregate per product (no facet JOIN to multiply rows),
        //      restricting to products that match the facet filter via EXISTS.
        //   2. After paginating, run a second query that returns the
        //      matching facets per product on the current page. The
        //      frontend joins those names into "Fruits, Saraswathi Pooja
        //      Special" and reuses the IDs to populate the filter dropdown.
        //
        // The from/to range is half-open (>= from, < to) to match calendar-month
        // semantics — pass the first day of the next month as `to` and there's
        // no risk of double-counting or missing midnight orders.
        const productMatchExists = `
            EXISTS (
                SELECT 1
                FROM product_facet_values_facet_value pfv
                INNER JOIN facet_value fv ON fv.id = pfv.facetValueId
                INNER JOIN facet fa ON fa.id = fv.facetId
                WHERE pfv.productId = p.id
                ${facetClause}
            )
        `;

        const baseProductFromWhere = `
            FROM order_line ol
            INNER JOIN \`order\` o ON o.id = ol.orderId
            INNER JOIN product_variant pv ON pv.id = ol.productVariantId
            INNER JOIN product_variant_translation pvt ON pvt.baseId = pv.id AND pvt.languageCode = 'en'
            INNER JOIN product p ON p.id = pv.productId
            INNER JOIN order_channels_channel occ ON occ.orderId = o.id
            WHERE o.state NOT IN ('Cancelled', 'CancellationRequested')
              AND (o.customFieldsCancellationreason IS NULL OR o.customFieldsCancellationreason = '')
              AND o.orderPlacedAt >= ?
              AND o.orderPlacedAt < ?
              AND occ.channelId IN (?)
              AND ${productMatchExists}
        `;

        const rowsSql = `
            SELECT ${MET_HINT}
                p.id                            AS productId,
                pvt.name                        AS productName,
                SUM(ol.quantity)                AS totalQuantitySold,
                SUM(ol.listPrice * ol.quantity) AS totalSalesAmount
            ${baseProductFromWhere}
            GROUP BY p.id, pvt.name
            ORDER BY pvt.name ASC, p.id ASC
            LIMIT ? OFFSET ?
        `;

        const countSql = `
            SELECT ${MET_HINT} COUNT(*) AS total FROM (
                SELECT p.id
                ${baseProductFromWhere}
                GROUP BY p.id
            ) sub
        `;

        // No facet JOIN in this query, so SUM is over distinct order_line rows
        // and totals are accurate regardless of how many facets each product has.
        const totalsSql = `
            SELECT ${MET_HINT}
                COALESCE(SUM(ol.quantity), 0)                 AS totalQuantitySold,
                COALESCE(SUM(ol.listPrice * ol.quantity), 0)  AS totalSalesAmount
            ${baseProductFromWhere}
        `;

        const baseParams = [from, to, channelIds, ...facetParams];
        const rowsParams = [...baseParams, take, skip];

        const db = this.connection.rawConnection;

        const [rows, countRows, totalsRows] = await Promise.all([
            db.query(rowsSql, rowsParams) as Promise<any[]>,
            db.query(countSql, baseParams) as Promise<Array<{ total: number | string }>>,
            db.query(totalsSql, baseParams) as Promise<
                Array<{ totalQuantitySold: number | string; totalSalesAmount: number | string }>
            >,
        ]);

        // Second query: matching facets per product on this page. Skipped
        // when the page is empty. Returned as a structured array per row so
        // the frontend can both render a comma-joined display string AND
        // populate the facet-filter dropdown (which needs the IDs).
        const pageProductIds = (rows as any[]).map(r => r.productId);
        const facetsByProduct = new Map<string, MonthlyProductFacetSummary[]>();
        if (pageProductIds.length > 0) {
            const facetsSql = `
                SELECT ${MET_HINT}
                    pfv.productId AS productId,
                    fv.id         AS facetId,
                    fvt.name      AS facetName
                FROM product_facet_values_facet_value pfv
                INNER JOIN facet_value fv ON fv.id = pfv.facetValueId
                INNER JOIN facet fa ON fa.id = fv.facetId
                INNER JOIN facet_value_translation fvt
                    ON fvt.baseId = fv.id AND fvt.languageCode = 'en'
                WHERE pfv.productId IN (?)
                  ${facetClause}
                ORDER BY pfv.productId, fvt.name ASC
            `;
            const facetRows = await db.query(facetsSql, [pageProductIds, ...facetParams]) as Array<{
                productId: ID; facetId: ID; facetName: string;
            }>;
            for (const fr of facetRows) {
                const key = String(fr.productId);
                const list = facetsByProduct.get(key) ?? [];
                list.push({ id: fr.facetId, name: fr.facetName });
                facetsByProduct.set(key, list);
            }
        }

        const items: MonthlyProductSalesReportRow[] = rows.map(r => ({
            productId: r.productId,
            productName: r.productName,
            facets: facetsByProduct.get(String(r.productId)) ?? [],
            totalQuantitySold: Number(r.totalQuantitySold),
            totalSalesAmount: Number(r.totalSalesAmount),
        }));

        return {
            items,
            totalItems: Number(countRows[0]?.total ?? 0),
            totalQuantitySold: Number(totalsRows[0]?.totalQuantitySold ?? 0),
            totalSalesAmount: Number(totalsRows[0]?.totalSalesAmount ?? 0),
        };
    }

    async getBillPrintReport(ctx: RequestContext, input: BillPrintReportInput): Promise<BillPrintReport> {
        const { from, to, skip, take } = this.normalizePagination(input);
        const channelIds = this.resolveChannelIds(ctx, input.channelIds);
        const states = input.states && input.states.length > 0 ? input.states : undefined;

        const cacheKey = cacheKeyFromInput('billPrint', ctx.channelId, {
            from, to, skip, take, channelIds, states,
        });

        return this.getOrCompute<BillPrintReport>(
            cacheKey,
            () => this.computeBillPrintReport(ctx, from, to, channelIds, states, skip, take),
        );
    }

    private async computeBillPrintReport(
        ctx: RequestContext,
        from: Date,
        to: Date,
        channelIds: ID[],
        states: string[] | undefined,
        skip: number,
        take: number,
    ): Promise<BillPrintReport> {
        Logger.info(
            `billPrintReport from=${from.toISOString()} to=${to.toISOString()} channels=${channelIds.join(
                ',',
            )} states=${states ? states.join(',') : '<default>'} skip=${skip} take=${take}`,
            loggerCtx,
        );

        // When the caller supplies an explicit state list, filter to those.
        // Otherwise fall back to the legacy exclusion set.
        const stateClause = states
            ? `O.state IN (?)`
            : `O.state NOT IN ('Delivered', 'Cancelled', 'AddingItems', 'CancellationRequested')`;

        /*
         * WHICH DATE the window is measured against.
         *
         * Every other caller asks about orders that were placed, so orderPlacedAt is
         * the right column and stays the default.
         *
         * An AddingItems order has not been placed — it is a basket someone is still
         * filling — so its orderPlacedAt is NULL, and `NULL BETWEEN … AND …` is not
         * true. Asking for those states matched the state and then dropped every row
         * on the date, returning an empty report with nothing to explain it.
         *
         * Only in that case does the window fall back to createdAt, which is the only
         * date such an order has. Narrowed to the states that need it rather than
         * applied to everything: COALESCE would stop the index on orderPlacedAt being
         * used, and no existing report should pay for a case it never asks about.
         */
        const wantsUnplacedOrders = states?.some(state => state === 'AddingItems' || state === 'Draft') ?? false;
        const dateColumn = wantsUnplacedOrders ? 'COALESCE(O.orderPlacedAt, O.createdAt)' : 'O.orderPlacedAt';

        // `cand` resolves the order-level filter (channel + date window + state +
        // cancellation flag) ONCE, up front. Every per-order LATEST/SUM sub-table
        // below then aggregates only the orders in `cand` via
        // `... IN (SELECT id FROM cand)` instead of grouping the FULL payment /
        // history_entry / order_line / shipping_line tables. On this DB those
        // tables hold hundreds of thousands of rows (history_entry ~720k,
        // order_line ~374k), so the un-scoped form scanned ~1.1M rows on every
        // load regardless of how few orders the page showed — the cause of the
        // multi-second loads and 504s. Scoped, the same query runs ~35x faster.
        // The CTE is the only place that consumes the channel/date/state params.
        const candCte = `
            WITH cand AS (
                -- DISTINCT is load-bearing, not tidiness. Every Vendure order
                -- belongs to its city channel AND __default_channel__, so a
                -- caller passing both gets the order twice here, and the
                -- INNER JOIN cand below then duplicates every one of its order
                -- lines. Measured before this fix: channelIds ["6"] -> 2 lines /
                -- qty 15; ["6","1"] -> 4 lines / qty 30. On the Purchase List
                -- that means ordering twice the vegetables. The dashboard hides
                -- the default channel in its picker, but a client-side guard
                -- cannot protect a server-side query -- the scheduled report is
                -- a second caller with no picker in front of it.
                SELECT DISTINCT O.id AS id
                FROM \`order\` O
                INNER JOIN order_channels_channel ch ON ch.orderId = O.id AND ch.channelId IN (?)
                WHERE ${dateColumn} BETWEEN ? AND ?
                  AND (O.customFieldsCancellationreason IS NULL OR O.customFieldsCancellationreason = '')
                  AND ${stateClause}
            )
        `;

        // Per-order LATEST-id subqueries for shipping_line / payment / history_entry
        // / order_modification stop the LEFT JOINs from multiplying rows when an
        // order has more than one of any of these. Without them, a 3-line order
        // with 2 payments and 2 modifications would emit 12 rows. Each is scoped
        // to `cand` so it only aggregates the orders this page can possibly show.
        // Lines cancelled down to nothing are left out (OL.quantity > 0, here
        // and in the count): Modify order keeps a cancelled line at quantity 0
        // as its record, and a bill must not list what the customer did not buy.
        const baseFromWhere = `
            FROM \`order\` O
            INNER JOIN cand ON cand.id = O.id
            LEFT JOIN customer C ON C.id = O.customerId
            INNER JOIN order_line OL ON O.id = OL.orderId AND OL.quantity > 0
            INNER JOIN product_variant pv ON pv.id = OL.productVariantId
            INNER JOIN product_variant_translation P ON P.baseId = pv.id AND P.languageCode = 'en'
            LEFT JOIN (
                SELECT sl.orderId, MAX(sl.shippingMethodId) AS shippingMethodId
                FROM shipping_line sl
                WHERE sl.orderId IN (SELECT id FROM cand)
                GROUP BY sl.orderId
            ) sl ON sl.orderId = O.id
            LEFT JOIN shipping_method sm ON sm.id = sl.shippingMethodId
            LEFT JOIN shipping_method_translation st ON st.baseId = sm.id AND st.languageCode = 'en'
            LEFT JOIN (
                SELECT orderId, MAX(id) AS max_id
                FROM payment
                WHERE state IN ('Settled', 'Authorized')
                  AND orderId IN (SELECT id FROM cand)
                GROUP BY orderId
            ) pmax ON pmax.orderId = O.id
            LEFT JOIN payment py ON py.id = pmax.max_id
            LEFT JOIN (
                SELECT orderId, MAX(id) AS max_id
                FROM history_entry
                WHERE type = 'ORDER_NOTE'
                  AND orderId IN (SELECT id FROM cand)
                GROUP BY orderId
            ) hmax ON hmax.orderId = O.id
            LEFT JOIN history_entry he ON he.id = hmax.max_id
            LEFT JOIN (
                SELECT orderId,
                       GROUP_CONCAT(
                           NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(data, '$.note'))), '')
                           ORDER BY id SEPARATOR ' | '
                       ) AS allNotes
                FROM history_entry
                WHERE type = 'ORDER_NOTE'
                  AND orderId IN (SELECT id FROM cand)
                GROUP BY orderId
            ) henotes ON henotes.orderId = O.id
            LEFT JOIN (
                SELECT orderId, MAX(id) AS max_id
                FROM order_modification
                WHERE orderId IN (SELECT id FROM cand)
                GROUP BY orderId
            ) mmax ON mmax.orderId = O.id
            LEFT JOIN order_modification om ON om.id = mmax.max_id
            LEFT JOIN (
                SELECT sl2.orderId, COALESCE(SUM(sl2.listPrice), 0) AS originalShipping
                FROM shipping_line sl2
                WHERE sl2.orderId IN (SELECT id FROM cand)
                GROUP BY sl2.orderId
            ) shipsum ON shipsum.orderId = O.id
            LEFT JOIN (
                SELECT s.orderId, COALESCE(-SUM(s.listPrice), 0) AS rewardDiscount
                FROM surcharge s
                WHERE s.description = 'Loyalty Points Discount'
                  AND s.orderId IN (SELECT id FROM cand)
                GROUP BY s.orderId
            ) loyalty ON loyalty.orderId = O.id
            LEFT JOIN (
                SELECT ol2.orderId, COALESCE(SUM(-CAST(adj.amount AS SIGNED)), 0) AS couponDiscount
                FROM order_line ol2
                CROSS JOIN JSON_TABLE(
                    IFNULL(ol2.adjustments, JSON_ARRAY()),
                    '$[*]' COLUMNS (
                        amount BIGINT PATH '$.amount',
                        type   VARCHAR(50) PATH '$.type'
                    )
                ) adj
                WHERE adj.type = 'PROMOTION'
                  AND ol2.orderId IN (SELECT id FROM cand)
                GROUP BY ol2.orderId
            ) cdisc ON cdisc.orderId = O.id
        `;
        // NOTE: the shipping_method join (sm/st above) is LEFT and used ONLY to
        // surface the delivery-slot name (st.name). It must NOT filter orders.
        // Previously a trailing `WHERE sm.deletedAt IS NULL AND sm.customFieldsEnabled = 1`
        // turned that LEFT JOIN into an inner filter, silently dropping every
        // delivered order whose slot was later retired (soft-deleted) or disabled —
        // e.g. Madurai showed 666 of 739 in the printed PDF. The candidate set is
        // fully defined by the cand CTE (channel + date window + state); shipping
        // method must never narrow it.

        const rowsSql = `
            ${candCte}
            SELECT ${MET_HINT}
                O.id                                          AS id,
                OL.id                                         AS orderLineId,
                pv.sku                                        AS pCode,
                ''                                            AS sNo,
                O.code                                        AS code,
                CAST(O.orderPlacedAt AS DATE)                 AS date,
                TIME(O.updatedAt)                             AS time,
                O.shippingAddress                             AS billingAddress,
                ''                                            AS customer,
                ''                                            AS address,
                ''                                            AS cellNo,
                TRIM(P.name)                                  AS itemName,
                ''                                            AS tamilName,
                OL.quantity                                   AS qty,
                pv.customFieldsShadowprice                    AS shadowPrice,
                OL.listPrice                                  AS rate,
                (OL.quantity * OL.listPrice)                  AS total,
                O.subTotalWithTax                             AS subTotal,
                O.shippingWithTax                             AS shipping,
                (O.subTotalWithTax + O.shippingWithTax)       AS netTotal,
                st.name                                       AS deliveryTime,
                O.customFieldsOtherinstructions               AS cuttingInstructions,
                COALESCE(JSON_UNQUOTE(JSON_EXTRACT(he.data, '$.note')), '') AS paymentMode,
                henotes.allNotes                                            AS orderHistoryNote,
                2                                             AS ordNo,
                O.customerId                                  AS customerId,
                ''                                            AS pincode,
                py.metadata                                   AS paymentMetadata,
                py.method                                     AS paymentMethod,
                ''                                            AS paymentStatus,
                O.customFieldsLoyaltypointsused               AS rewardPointUsed,
                C.customFieldsLoyaltypointsavailable          AS loyaltyPointsAvailable,
                O.couponCodes                                 AS couponCode,
                om.note                                       AS note,
                COALESCE(O.customFieldsInvoiceno, '')         AS invoiceNo,
                COALESCE(cdisc.couponDiscount, 0)             AS couponDiscount,
                COALESCE(loyalty.rewardDiscount, 0)           AS rewardDiscount,
                COALESCE(shipsum.originalShipping, O.shippingWithTax) AS originalShipping
            ${baseFromWhere}
            ORDER BY ordNo ASC, O.updatedAt ASC, O.code ASC
            LIMIT ? OFFSET ?
        `;

        // The count only depends on the joins that change row cardinality:
        // order_line (one row per line) and the product_variant + English
        // translation INNER JOINs. The note/payment/coupon/modification/shipping
        // sub-tables are all 1:1 LEFT JOINs that never change the count, so they
        // are omitted here — this is what makes the count query cheap. (The
        // shipping_method status filter that used to live here was removed: it
        // was incorrectly dropping delivered orders on retired/disabled slots.)
        const countSql = `
            ${candCte}
            SELECT ${MET_HINT} COUNT(*) AS total
            FROM \`order\` O
            INNER JOIN cand ON cand.id = O.id
            INNER JOIN order_line OL ON O.id = OL.orderId AND OL.quantity > 0
            INNER JOIN product_variant pv ON pv.id = OL.productVariantId
            INNER JOIN product_variant_translation P ON P.baseId = pv.id AND P.languageCode = 'en'
        `;

        // Only the CTE takes params (channel, date window, optional states).
        const baseParams = states ? [channelIds, from, to, states] : [channelIds, from, to];
        const rowsParams = [...baseParams, take, skip];

        const db = this.connection.rawConnection;

        const [rows, countRows] = await Promise.all([
            db.query(rowsSql, rowsParams) as Promise<any[]>,
            db.query(countSql, baseParams) as Promise<Array<{ total: number | string }>>,
        ]);

        const orderIds = Array.from(new Set(rows.map(r => r.id)));
        const enrichment = await this.loadBillPrintEnrichment(ctx, orderIds);

        const items: BillPrintReportRow[] = rows.map(r => {
            const orderId = r.id;
            const rewardPointUsed = r.rewardPointUsed == null ? null : Number(r.rewardPointUsed);
            const isOnline = enrichment.onlineOrderIds.has(String(orderId));
            const isAdminPaid = enrichment.billPaidOrderIds.has(String(orderId));
            const lineTax = enrichment.taxByLine.get(String(r.orderLineId));
            const totalTaxAmount = enrichment.totalTaxByOrder.get(String(orderId)) ?? 0;
            return {
                id: r.id,
                pCode: r.pCode ?? null,
                sNo: r.sNo ?? '',
                code: r.code,
                date: this.formatDate(r.date),
                time: r.time ?? null,
                billingAddress: this.stringifyJsonish(r.billingAddress),
                customer: r.customer ?? '',
                address: r.address ?? '',
                cellNo: r.cellNo ?? '',
                itemName: r.itemName,
                tamilName: r.tamilName ?? '',
                qty: Number(r.qty),
                shadowPrice: r.shadowPrice == null ? null : Number(r.shadowPrice),
                rate: Number(r.rate),
                total: Number(r.total),
                subTotal: Number(r.subTotal),
                shipping: Number(r.shipping),
                netTotal: Number(r.netTotal),
                deliveryTime: r.deliveryTime ?? null,
                cuttingInstructions: r.cuttingInstructions ?? null,
                paymentMode: r.paymentMode ?? '',
                ordNo: Number(r.ordNo),
                customerId: r.customerId ?? null,
                pincode: r.pincode ?? '',
                paymentMetadata: this.stringifyJsonish(r.paymentMetadata),
                paymentMethod: r.paymentMethod ?? null,
                paymentStatus: r.paymentStatus ?? '',
                rewardPointUsed,
                couponCode: this.stringifyJsonish(r.couponCode),
                note: r.orderHistoryNote ?? null,
                orderModifyNote: r.note ?? null,
                invoiceNo: r.invoiceNo ?? '',
                couponDiscount: Number(r.couponDiscount ?? 0),
                rewardDiscount: Number(r.rewardDiscount ?? 0),
                originalShipping: Number(r.originalShipping ?? 0),
                discounts: enrichment.discountsByOrder.get(String(orderId)) ?? [],
                loyaltyPointsUsed: rewardPointUsed,
                loyaltyPointsAvailable: r.loyaltyPointsAvailable == null ? null : Number(r.loyaltyPointsAvailable),
                paymentType: isOnline || isAdminPaid ? 'ONLINE' : 'COD',
                adminMarkedAsPaid: isAdminPaid,
                hsnCode: lineTax?.hsnCode ?? null,
                taxRate: lineTax?.taxRate ?? 0,
                taxAmount: lineTax?.taxAmount ?? 0,
                priceBeforeTax: lineTax?.priceBeforeTax ?? 0,
                totalTaxAmount,
                discountedTotal: lineTax?.discountedTotal ?? Number(r.total),
                isFree: lineTax?.isFree ?? false,
            };
        });

        return {
            items,
            totalItems: Number(countRows[0]?.total ?? 0),
        };
    }

    /**
     * Order-level enrichment for bill-print rows. Fans out four queries in
     * parallel keyed by orderId, then a follow-up promotion lookup to attach
     * couponCodes to discount entries.
     *
     * Discounts include line-level PROMOTION adjustments (coupon savings) and
     * the loyalty-points surcharge synthesised as a discount entry. Free-
     * shipping promo savings live in shipping_line.adjustments and are
     * deliberately excluded — the frontend renders them as a separate "Free
     * Shipping (saved ₹X)" line driven by `originalShipping` vs `shipping`,
     * so including them in `discounts[]` would double-render.
     */
    private async loadBillPrintEnrichment(ctx: RequestContext, orderIds: ID[]): Promise<{
        discountsByOrder: Map<string, BillPrintDiscount[]>;
        onlineOrderIds: Set<string>;
        billPaidOrderIds: Set<string>;
        taxByLine: Map<string, BillLineInfo>;
        totalTaxByOrder: Map<string, number>;
    }> {
        const empty = {
            discountsByOrder: new Map<string, BillPrintDiscount[]>(),
            onlineOrderIds: new Set<string>(),
            billPaidOrderIds: new Set<string>(),
            taxByLine: new Map<string, BillLineInfo>(),
            totalTaxByOrder: new Map<string, number>(),
        };
        if (orderIds.length === 0) return empty;

        const db = this.connection.rawConnection;

        const loyaltySurchargeSql = `
            SELECT s.id AS id, s.orderId AS orderId, s.description AS description, s.listPrice AS listPrice
            FROM surcharge s
            WHERE s.orderId IN (?)
              AND s.description = 'Loyalty Points Discount'
        `;

        const onlinePaymentSql = `
            SELECT DISTINCT p.orderId AS orderId
            FROM payment p
            WHERE p.orderId IN (?)
              AND p.method IN ('razorpay-payment')
              AND p.state NOT IN ('Cancelled', 'Declined')
        `;

        // Match bill-paid notes case-insensitively and tolerant of whitespace
        // ("bill paid", "BillPaid", "Bill  Paid"). Strip spaces, lowercase,
        // then substring-match — portable across collations and avoids any
        // dependency on default REGEXP behaviour.
        const billPaidSql = `
            SELECT DISTINCT he.orderId AS orderId
            FROM history_entry he
            WHERE he.orderId IN (?)
              AND he.type = 'ORDER_NOTE'
              AND LOWER(REPLACE(IFNULL(JSON_UNQUOTE(JSON_EXTRACT(he.data, '$.note')), ''), ' ', '')) LIKE '%billpaid%'
        `;

        // Use Vendure's Order.discounts getter (same source the Admin UI reads)
        // instead of JSON-querying order_line.adjustments. The previous raw-SQL
        // approach returned zero PROMOTION entries on this codebase: either the
        // adjustment type label differs from 'PROMOTION' in stored JSON, or
        // promotion accounting isn't persisted in the column at all on this
        // version. The getter is the canonical source and handles both cases.
        //
        // Note: only `lines` is loaded — the getter falls back to `[]` when
        // `shippingLines` isn't joined, which conveniently excludes free-
        // shipping promotions from `discounts[]`. Those savings are surfaced
        // separately via `originalShipping` vs `shipping` so the bill renders
        // them as their own line, not duplicated here.
        const orderRepo = this.connection.getRepository(ctx, Order);
        const ordersPromise = orderRepo.find({
            where: { id: In(orderIds as Array<string | number>) },
            relations: ['lines', 'lines.productVariant', 'lines.productVariant.product'],
        });

        const [orders, loyaltyRows, onlineRows, billPaidRows] = await Promise.all([
            ordersPromise,
            db.query(loyaltySurchargeSql, [orderIds]) as Promise<
                Array<{ id: ID; orderId: ID; description: string; listPrice: number | string }>
            >,
            db.query(onlinePaymentSql, [orderIds]) as Promise<Array<{ orderId: ID }>>,
            db.query(billPaidSql, [orderIds]) as Promise<Array<{ orderId: ID }>>,
        ]);

        // Build per-line tax/HSN map and per-order tax total. Uses the
        // prorated line totals so coupon/promotion discounts that distribute
        // to the line shrink the taxable base — matching Vendure's own tax
        // summary. `linePrice`/`linePriceWithTax` would be pre-discount and
        // overstate tax whenever a coupon is applied.
        const taxByLine = new Map<string, BillLineInfo>();
        const totalTaxByOrder = new Map<string, number>();
        for (const order of orders) {
            let orderTaxTotal = 0;
            for (const line of order.lines ?? []) {
                const before = Number(line.proratedLinePrice ?? 0);
                const withTax = Number(line.proratedLinePriceWithTax ?? 0);
                const tax = withTax - before;
                orderTaxTotal += tax;
                const hsn =
                    ((line.productVariant?.product?.customFields as { hsnCode?: string } | undefined)
                        ?.hsnCode as string | undefined) ?? null;
                taxByLine.set(String(line.id), {
                    taxRate: Number(line.taxRate ?? 0),
                    taxAmount: tax,
                    priceBeforeTax: before,
                    hsnCode: hsn && hsn.length > 0 ? hsn : null,
                    // Item-level coupon discounts only (free product, product
                    // %); order-level ones stay a separate bill line.
                    ...billLineAmounts({
                        linePriceWithTax: Number(line.linePriceWithTax ?? 0),
                        discountedLinePriceWithTax: Number(line.discountedLinePriceWithTax ?? 0),
                    }),
                });
            }
            totalTaxByOrder.set(String(order.id), orderTaxTotal);
        }

        // Collect every PROMOTION:N id across all orders, then batch-fetch
        // their couponCodes in one query.
        const promoIds = new Set<string>();
        for (const order of orders) {
            for (const d of order.discounts) {
                const m = /^PROMOTION:(\d+)$/.exec(d.adjustmentSource);
                if (m) promoIds.add(m[1]);
            }
        }
        const promoCodeById = new Map<string, string | null>();
        if (promoIds.size > 0) {
            const promotions = await this.connection.getRepository(ctx, Promotion).find({
                where: { id: In(Array.from(promoIds)) },
            });
            for (const p of promotions) {
                promoCodeById.set(String(p.id), p.couponCode ?? null);
            }
        }

        // The getter already groups by adjustmentSource within each order, so
        // we can map straight across without another dedupe layer.
        const grouped = new Map<string, Map<string, BillPrintDiscount>>();
        for (const order of orders) {
            const orderKey = String(order.id);
            const orderMap = new Map<string, BillPrintDiscount>();
            for (const d of order.discounts) {
                const promoIdMatch = /^PROMOTION:(\d+)$/.exec(d.adjustmentSource)?.[1];
                orderMap.set(d.adjustmentSource, {
                    description: d.description,
                    code: promoIdMatch ? promoCodeById.get(promoIdMatch) ?? null : null,
                    source: d.adjustmentSource,
                    amount: Math.abs(d.amountWithTax ?? d.amount),
                });
            }
            grouped.set(orderKey, orderMap);
        }

        // Append loyalty surcharge as a synthetic discount entry per order.
        for (const ls of loyaltyRows) {
            const orderKey = String(ls.orderId);
            const orderMap = grouped.get(orderKey) ?? new Map<string, BillPrintDiscount>();
            const synthKey = `SURCHARGE:${ls.id}`;
            orderMap.set(synthKey, {
                description: ls.description,
                code: null,
                source: synthKey,
                amount: Math.abs(Number(ls.listPrice)),
            });
            grouped.set(orderKey, orderMap);
        }

        const discountsByOrder = new Map<string, BillPrintDiscount[]>();
        for (const [orderKey, m] of grouped.entries()) {
            discountsByOrder.set(orderKey, Array.from(m.values()));
        }

        return {
            discountsByOrder,
            onlineOrderIds: new Set(onlineRows.map(r => String(r.orderId))),
            billPaidOrderIds: new Set(billPaidRows.map(r => String(r.orderId))),
            taxByLine,
            totalTaxByOrder,
        };
    }

    // mysql2 returns DATE columns as either Date objects or 'YYYY-MM-DD'
    // strings depending on driver options. Normalise to 'YYYY-MM-DD'.
    private formatDate(value: unknown): string | null {
        if (value == null) return null;
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        return String(value);
    }

    // JSON / simple-json columns can come back as parsed objects (mysql2's
    // JSON parsing) or as raw strings. Normalise to a string for the API.
    private stringifyJsonish(value: unknown): string | null {
        if (value == null) return null;
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    private normalizePagination(input: { from: Date; to: Date; skip?: number; take?: number }): {
        from: Date;
        to: Date;
        skip: number;
        take: number;
    } {
        const skip = Math.max(0, input.skip ?? 0);
        const requested = input.take ?? DEFAULT_TAKE;
        const take = Math.min(MAX_TAKE, Math.max(1, requested));
        return { from: input.from, to: input.to, skip, take };
    }

    private resolveChannelIds(ctx: RequestContext, requested?: ID[]): ID[] {
        if (requested && requested.length > 0) {
            return requested;
        }
        return [ctx.channelId];
    }
}
