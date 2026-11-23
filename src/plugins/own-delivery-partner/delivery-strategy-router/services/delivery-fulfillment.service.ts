import { Injectable } from '@nestjs/common';
import {
    CacheService,
    RequestContext,
    TransactionalConnection,
    FulfillmentService,
    Logger,
    ID,
    isGraphQlErrorResult,
} from '@vendure/core';
import { DELIVERY_REPORT_TAG } from './delivery-report.service';

const loggerCtx = 'DeliveryFulfillmentService';

/** Input for recording payment collection during delivery */
export interface PaymentCollectionInput {
    paymentCollectionMethod: string;
    collectedAmount: number;
    collectionNote?: string;
}

@Injectable()
export class DeliveryFulfillmentService {
    constructor(
        private connection: TransactionalConnection,
        private fulfillmentService: FulfillmentService,
        private cacheService: CacheService,
    ) {}

    /**
     * Transition a fulfillment to a given state.
     * When transitioning to Delivered, records payment collection info first.
     *
     * Idempotency: if a duplicate call arrives (PWA service-worker retry,
     * double click, network replay), the pessimistic_write lock makes the
     * second caller block until the first commits. The second caller then
     * sees the row already in the target state and returns early — payment
     * is NOT re-recorded, and we don't fire FULFILLMENT_STATE_TRANSITION_ERROR.
     *
     * `withTransaction` is reentrant: the resolver path (already wrapped in
     * `@Transaction()`) reuses the existing transaction; the subscriber path
     * (auto-ship on payment-settled) opens a fresh one. Both get a real
     * transaction so the pessimistic lock has something to attach to.
     */
    async transitionFulfillmentToState(
        ctx: RequestContext,
        fulfillmentId: ID,
        state: string,
        paymentCollection?: PaymentCollectionInput,
    ) {
        return this.connection.withTransaction(ctx, async txCtx => {
            const current = await this.connection
                .getRepository(txCtx, 'Fulfillment')
                .createQueryBuilder('f')
                .setLock('pessimistic_write')
                .where('f.id = :id', { id: fulfillmentId })
                .getOne() as any;
            if (!current) {
                throw new Error(`Fulfillment ${fulfillmentId} not found`);
            }
            if (current.state === state) {
                Logger.info(
                    `Fulfillment ${fulfillmentId} already in state "${state}" — skipping duplicate transition`,
                    loggerCtx,
                );
                return current;
            }
            if (state === 'Delivered') {
                await this.recordPaymentCollection(txCtx, fulfillmentId, paymentCollection);
            }
            try {
                const result = await this.fulfillmentService.transitionToState(txCtx, fulfillmentId, state as any);
                if (isGraphQlErrorResult(result)) {
                    throw new Error((result as any).message || `Failed to transition fulfillment to "${state}"`);
                }
                Logger.info(
                    `Transitioned fulfillment ${fulfillmentId} from "${result.fromState}" to "${result.toState}"`,
                    loggerCtx,
                );
                if (state === 'Delivered') {
                    await this.cacheService.invalidateTags([DELIVERY_REPORT_TAG]);
                }
                return result.fulfillment;
            } catch (e: any) {
                Logger.error(`Failed to transition fulfillment ${fulfillmentId} to "${state}": ${e.message}`, loggerCtx);
                throw e;
            }
        });
    }

    /**
     * Record payment collection details on the fulfillment before transitioning to Delivered.
     *
     * OPTIMIZED: Uses a lightweight raw query (3 scalar values) instead of loading
     * the full entity graph (fulfillment→lines→orderLine→order→payments).
     * Then uses a direct UPDATE instead of load-then-save.
     */
    private async recordPaymentCollection(
        ctx: RequestContext,
        fulfillmentId: ID,
        paymentCollection?: PaymentCollectionInput,
    ): Promise<void> {
        // 1. Lightweight raw query: get order total + payment type in one shot
        const orderData = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .leftJoin('o.payments', 'p')
            .select('o.subTotalWithTax', 'subTotalWithTax')
            .addSelect('o.shippingWithTax', 'shippingWithTax')
            .addSelect(
                `MAX(CASE WHEN p.method = 'razorpay-payment' AND p.state IN ('Settled','Authorized') THEN 1 ELSE 0 END)`,
                'isOnlinePayment',
            )
            .where('f.id = :id', { id: fulfillmentId })
            .groupBy('o.id')
            .getRawOne();
        if (!orderData) {
            throw new Error('Could not find order for fulfillment');
        }
        const orderTotal = (parseInt(orderData.subTotalWithTax, 10) || 0)
            + (parseInt(orderData.shippingWithTax, 10) || 0);
        const isOnlinePayment = parseInt(orderData.isOnlinePayment, 10) === 1;
        // 2. Determine payment collection values
        let collectionMethod: string;
        let collectedAmount: number;
        let collectionNote: string | null = null;
        if (isOnlinePayment) {
            collectionMethod = 'Online';
            collectedAmount = orderTotal;
        } else {
            if (!paymentCollection) {
                throw new Error('Payment collection details are required for offline/COD orders. Specify Cash or QR.');
            }
            if (!['Cash', 'QR', 'Cash+QR'].includes(paymentCollection.paymentCollectionMethod)) {
                throw new Error('Payment collection method must be "Cash", "QR", or "Cash+QR"');
            }
            collectionMethod = paymentCollection.paymentCollectionMethod;
            collectedAmount = paymentCollection.collectedAmount;
            if (collectedAmount !== orderTotal) {
                if (!paymentCollection.collectionNote || paymentCollection.collectionNote.trim() === '') {
                    throw new Error(
                        `Collected amount (${collectedAmount}) does not match order total (${orderTotal}). ` +
                        `Please provide a collectionNote explaining the reason.`,
                    );
                }
                collectionNote = paymentCollection.collectionNote.trim();
            } else {
                collectionNote = paymentCollection.collectionNote?.trim() || null;
            }
        }
        // 3. Load-then-save to properly persist custom fields via TypeORM entity manager
        //    (createQueryBuilder().update().set() does not map customFields dot-notation to columns)
        const fulfillment = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .findOne({ where: { id: fulfillmentId } }) as any;
        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }
        fulfillment.customFields = {
            ...fulfillment.customFields,
            paymentCollectionMethod: collectionMethod,
            collectedAmount: collectedAmount,
            collectionNote: collectionNote,
            deliveredAt: new Date(),
        };
        if (collectionMethod === 'Cash') {
            // Auto-close active QR if DP is paying all-cash
            if (fulfillment.customFields?.qrCodeId && fulfillment.customFields.qrCodeStatus === 'active') {
                fulfillment.customFields.qrCodeStatus = 'closed';
                Logger.info(
                    `Auto-closing QR ${fulfillment.customFields.qrCodeId} — DP paying all-cash for fulfillment ${fulfillmentId}`,
                    loggerCtx,
                );
            }
        }
        await this.connection
            .getRepository(ctx, 'Fulfillment')
            .save(fulfillment);
        Logger.info(
            `Recorded payment: fulfillment ${fulfillmentId}, method: ${collectionMethod}, amount: ${collectedAmount}${collectionNote ? `, note: ${collectionNote}` : ''}`,
            loggerCtx,
        );
    }
}
