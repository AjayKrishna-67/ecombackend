import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    CacheService,
    RequestContext,
    TransactionalConnection,
    ID,
    Logger,
} from '@vendure/core';

/** Effective role of the caller for delivery report scoping */
export type CallerRole = 'DELIVERY_PERSON' | 'ACCOUNTANT' | 'ADMIN';

/** Combined result of role detection + admin ID lookup (single query) */
export interface CallerContext {
    role: CallerRole;
    adminId: ID;
}

export interface DeliveryReportInput {
    dateFrom: Date;
    dateTo: Date;
    skip?: number;
    take?: number;
    deliveryPersonId?: ID;
}

const loggerCtx = 'DeliveryReportService';

/** Cache aggregated delivery report data. Invalidated on each new Delivered transition. */
export const DELIVERY_REPORT_TAG = 'delivery-report:all';
const DELIVERY_REPORT_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class DeliveryReportService implements OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private cacheService: CacheService,
    ) {}

    /**
     * One-time backfill on startup: patches legacy Delivered fulfillments
     * that have null deliveredAt / paymentCollectionMethod / collectedAmount
     * because the old createQueryBuilder().update().set() with dot-notation wasn't persisting.
     */
    async onApplicationBootstrap(): Promise<void> {
        const queryRunner = this.connection.rawConnection.createQueryRunner();
        try {
            // 1. Backfill deliveredAt from updatedAt.
            //    Covers BOTH DP-fulfilled rows AND admin-fulfilled rows
            //    (where customFieldsDeliverypersonid is NULL because no
            //    DP was assigned — e.g. order transitioned to Delivered
            //    directly from the Vendure admin UI). The Sales Report
            //    filters on customFieldsDeliveredat, so any Delivered
            //    fulfillment lacking this timestamp would be invisible.
            const dateResult = await queryRunner.query(`
                UPDATE fulfillment
                SET customFieldsDeliveredat = updatedAt
                WHERE state = 'Delivered'
                  AND customFieldsDeliveredat IS NULL
            `);
            const dateRows = dateResult?.affectedRows ?? 0;
            if (dateRows > 0) {
                Logger.info(`Backfilled deliveredAt for ${dateRows} legacy fulfillments`, loggerCtx);
            }
            // 2. Backfill paymentCollectionMethod and collectedAmount from order payment data
            const paymentResult = await queryRunner.query(`
                UPDATE fulfillment f
                INNER JOIN order_line_reference fl ON fl.fulfillmentId = f.id AND fl.discriminator = 'FulfillmentLine'
                INNER JOIN order_line ol ON ol.id = fl.orderLineId
                INNER JOIN \`order\` o ON o.id = ol.orderId
                LEFT JOIN payment p ON p.orderId = o.id
                SET
                    f.customFieldsPaymentcollectionmethod = CASE
                        WHEN f.customFieldsPaymentlinkstatus = 'paid' THEN 'PaymentLink'
                        WHEN f.customFieldsQrcodestatus = 'paid' AND COALESCE(f.customFieldsQrcashamount, 0) > 0 THEN 'Cash+QR'
                        WHEN f.customFieldsQrcodestatus = 'paid' THEN 'QR'
                        WHEN p.method = 'razorpay-payment' THEN 'Online'
                        ELSE 'Cash'
                    END,
                    f.customFieldsCollectedamount = o.subTotalWithTax + o.shippingWithTax
                WHERE f.state = 'Delivered'
                  AND f.customFieldsDeliverypersonid IS NOT NULL
                  AND f.customFieldsPaymentcollectionmethod IS NULL
            `);
            const paymentRows = paymentResult?.affectedRows ?? 0;
            if (paymentRows > 0) {
                Logger.info(`Backfilled paymentCollectionMethod for ${paymentRows} legacy fulfillments`, loggerCtx);
            }
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Resolve the caller's effective role AND admin ID in a single query.
     */
    async resolveCallerContext(ctx: RequestContext): Promise<CallerContext> {
        if (!ctx.activeUserId) {
            throw new Error('Not authenticated');
        }
        const admin = await this.connection
            .getRepository(ctx, 'Administrator')
            .createQueryBuilder('admin')
            .leftJoinAndSelect('admin.user', 'user')
            .leftJoinAndSelect('user.roles', 'role')
            .leftJoin('role.channels', 'channel')
            .where('user.id = :userId', { userId: ctx.activeUserId })
            .andWhere('admin.deletedAt IS NULL')
            .andWhere('(channel.id = :channelId OR role.code = :superAdminCode)', {
                channelId: ctx.channelId,
                superAdminCode: '__super_admin_role__',
            })
            .getOne() as any;
        if (!admin?.user) {
            throw new Error('Administrator not found');
        }
        const permissions = new Set<string>();
        for (const role of admin.user.roles || []) {
            for (const perm of role.permissions || []) {
                permissions.add(perm);
            }
        }
        let callerRole: CallerRole;
        if (permissions.has('SuperAdmin') || permissions.has('CustomFulfillment')) {
            callerRole = 'ADMIN';
        } else if (permissions.has('ViewDeliveryReports')) {
            callerRole = 'ACCOUNTANT';
        } else {
            callerRole = 'DELIVERY_PERSON';
        }
        return { role: callerRole, adminId: admin.id };
    }

    /**
     * Unified delivery report with permission-based scoping and SQL aggregation.
     *
     * - ADMIN/ACCOUNTANT → all DPs overview (no fulfillment details unless deliveryPersonId passed)
     * - DELIVERY_PERSON → scoped to own adminId, with fulfillment details
     */
    async getDeliveryReport(ctx: RequestContext, input: DeliveryReportInput) {
        const { role: callerRole, adminId } = await this.resolveCallerContext(ctx);
        const effectiveDpId: ID | undefined = callerRole === 'DELIVERY_PERSON'
            ? adminId
            : input.deliveryPersonId || undefined;
        Logger.info(
            `Report: role=${callerRole}, adminId=${adminId}, dpFilter=${effectiveDpId ?? 'all'}, channel=${ctx.channelId}`,
            loggerCtx,
        );
        const skip = input.skip ?? 0;
        const take = input.take ?? 50;
        const cacheKey = `delivery-report:${ctx.channelId}:${callerRole}:${effectiveDpId ?? 'all'}:${input.dateFrom.getTime()}:${input.dateTo.getTime()}:${skip}:${take}`;
        const cached = await this.cacheService.get(cacheKey);
        if (cached) {
            return cached;
        }
        // 1. SQL aggregate summaries per delivery person (channel-aware)
        //    Uses EXISTS for channel filtering instead of JOINs to avoid row
        //    multiplication from multiple fulfillment lines per fulfillment.
        const summaryQb = this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .select('f.customFieldsDeliverypersonid', 'dpId')
            .addSelect('f.customFieldsDeliverypersonname', 'dpName')
            .addSelect('f.customFieldsDeliverypersonphone', 'dpPhone')
            .addSelect('COUNT(f.id)', 'totalDeliveries')
            .addSelect(`SUM(CASE WHEN f.customFieldsPaymentcollectionmethod = 'Cash' THEN 1 ELSE 0 END)`, 'cashCount')
            .addSelect(`SUM(CASE WHEN f.customFieldsPaymentcollectionmethod IN ('QR','Cash+QR') THEN 1 ELSE 0 END)`, 'qrCount')
            .addSelect(`SUM(CASE WHEN f.customFieldsPaymentcollectionmethod = 'Online' THEN 1 ELSE 0 END)`, 'onlineCount')
            .addSelect(`SUM(CASE WHEN f.customFieldsPaymentcollectionmethod = 'PaymentLink' THEN 1 ELSE 0 END)`, 'paymentLinkCount')
            // Cash total: pure Cash orders (full amount) + Cash+QR orders (cash portion only)
            .addSelect(`SUM(CASE
                WHEN f.customFieldsPaymentcollectionmethod = 'Cash' THEN COALESCE(f.customFieldsCollectedamount, 0)
                WHEN f.customFieldsPaymentcollectionmethod = 'Cash+QR' THEN COALESCE(f.customFieldsQrcashamount, 0)
                ELSE 0
            END)`, 'totalCashAmount')
            // QR total: pure QR orders (full amount) + Cash+QR orders (QR portion only)
            .addSelect(`SUM(CASE
                WHEN f.customFieldsPaymentcollectionmethod = 'QR' THEN COALESCE(f.customFieldsCollectedamount, 0)
                WHEN f.customFieldsPaymentcollectionmethod = 'Cash+QR' THEN COALESCE(f.customFieldsQramount, 0)
                ELSE 0
            END)`, 'totalQrAmount')
            .addSelect(`SUM(CASE WHEN f.customFieldsPaymentcollectionmethod = 'Online' THEN COALESCE(f.customFieldsCollectedamount, 0) ELSE 0 END)`, 'totalOnlineAmount')
            .addSelect(`SUM(CASE WHEN f.customFieldsPaymentcollectionmethod = 'PaymentLink' THEN COALESCE(f.customFieldsCollectedamount, 0) ELSE 0 END)`, 'totalPaymentLinkAmount')
            .where('f.state = :state', { state: 'Delivered' })
            .andWhere('f.customFieldsDeliverypersonid IS NOT NULL')
            .andWhere('f.customFieldsDeliveredat >= :dateFrom', { dateFrom: input.dateFrom })
            .andWhere('f.customFieldsDeliveredat <= :dateTo', { dateTo: input.dateTo })
            .andWhere(`EXISTS (
                SELECT 1 FROM order_line_reference flx
                INNER JOIN order_line olx ON olx.id = flx.orderLineId
                INNER JOIN \`order\` ox ON ox.id = olx.orderId
                INNER JOIN order_channels_channel occ ON occ.orderId = ox.id
                WHERE flx.fulfillmentId = f.id AND flx.discriminator = 'FulfillmentLine' AND occ.channelId = :channelId
            )`, { channelId: ctx.channelId })
            .groupBy('f.customFieldsDeliverypersonid')
            .addGroupBy('f.customFieldsDeliverypersonname')
            .addGroupBy('f.customFieldsDeliverypersonphone');
        if (effectiveDpId) {
            summaryQb.andWhere('f.customFieldsDeliverypersonid = :dpId', { dpId: effectiveDpId });
        }
        const summaryRows = await summaryQb.getRawMany();
        const summaries = summaryRows.map(row => ({
            deliveryPersonId: row.dpId || '',
            deliveryPersonName: row.dpName || '',
            deliveryPersonPhone: row.dpPhone || null,
            totalDeliveries: parseInt(row.totalDeliveries, 10) || 0,
            cashCount: parseInt(row.cashCount, 10) || 0,
            qrCount: parseInt(row.qrCount, 10) || 0,
            onlineCount: parseInt(row.onlineCount, 10) || 0,
            paymentLinkCount: parseInt(row.paymentLinkCount, 10) || 0,
            totalCashAmount: parseInt(row.totalCashAmount, 10) || 0,
            totalQrAmount: parseInt(row.totalQrAmount, 10) || 0,
            totalOnlineAmount: parseInt(row.totalOnlineAmount, 10) || 0,
            totalPaymentLinkAmount: parseInt(row.totalPaymentLinkAmount, 10) || 0,
            fulfillments: [] as any[],
        }));
        // 2. Fulfillment details: loaded when viewing a single DP (own view or admin drill-down)
        if (effectiveDpId && summaries.length > 0) {
            const detailQb = this.connection
                .getRepository(ctx, 'Fulfillment')
                .createQueryBuilder('f')
                .leftJoinAndSelect('f.lines', 'fl')
                .leftJoinAndSelect('fl.orderLine', 'ol')
                .leftJoinAndSelect('ol.order', 'o')
                .leftJoinAndSelect('o.customer', 'c')
                .leftJoin('o.channels', 'ch')
                .where('f.state = :state', { state: 'Delivered' })
                .andWhere('f.customFieldsDeliverypersonid = :dpId', { dpId: effectiveDpId })
                .andWhere('f.customFieldsDeliveredat >= :dateFrom', { dateFrom: input.dateFrom })
                .andWhere('f.customFieldsDeliveredat <= :dateTo', { dateTo: input.dateTo })
                .andWhere('ch.id = :channelId', { channelId: ctx.channelId })
                .orderBy('f.createdAt', 'DESC')
                .skip(skip)
                .take(take);
            const fulfillments = await detailQb.getMany();
            summaries[0].fulfillments = fulfillments.map((f: any) => {
                const order = f.lines?.[0]?.orderLine?.order;
                const orderTotal = order ? (order.subTotalWithTax || 0) + (order.shippingWithTax || 0) : 0;
                const customer = order?.customer;
                return {
                    fulfillmentId: f.id,
                    orderCode: order?.code || '',
                    orderTotal,
                    paymentCollectionMethod: f.customFields?.paymentCollectionMethod || 'Cash',
                    collectedAmount: f.customFields?.collectedAmount || 0,
                    collectionNote: f.customFields?.collectionNote || null,
                    // Split amounts for Cash+QR display
                    qrCashAmount: f.customFields?.qrCashAmount || 0,
                    qrAmount: f.customFields?.qrAmount || 0,
                    deliveredAt: f.customFields?.deliveredAt || null,
                    deliveryPersonName: f.customFields?.deliveryPersonName || '',
                    deliveryPersonId: f.customFields?.deliveryPersonId || '',
                    customerName: customer
                        ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || null
                        : null,
                };
            });
        }
        // 3. Compute grand totals
        const result = {
            callerRole,
            summaries,
            grandTotalDeliveries: summaries.reduce((s, r) => s + r.totalDeliveries, 0),
            grandTotalCashCount: summaries.reduce((s, r) => s + r.cashCount, 0),
            grandTotalQrCount: summaries.reduce((s, r) => s + r.qrCount, 0),
            grandTotalOnlineCount: summaries.reduce((s, r) => s + r.onlineCount, 0),
            grandTotalPaymentLinkCount: summaries.reduce((s, r) => s + r.paymentLinkCount, 0),
            grandTotalCashAmount: summaries.reduce((s, r) => s + r.totalCashAmount, 0),
            grandTotalQrAmount: summaries.reduce((s, r) => s + r.totalQrAmount, 0),
            grandTotalOnlineAmount: summaries.reduce((s, r) => s + r.totalOnlineAmount, 0),
            grandTotalPaymentLinkAmount: summaries.reduce((s, r) => s + r.totalPaymentLinkAmount, 0),
        };
        await this.cacheService.set(cacheKey, result as any, {
            ttl: DELIVERY_REPORT_TTL_MS,
            tags: [DELIVERY_REPORT_TAG],
        });
        return result;
    }
}
