import { Injectable } from '@nestjs/common';
import {
    CacheService,
    RequestContext,
    TransactionalConnection,
    FulfillmentService,
    PaymentMethod,
    Logger,
    ID,
    isGraphQlErrorResult,
} from '@vendure/core';
import { getRazorpayConfig } from '../../../Payment/Razorpay/utils/config-helper';
import { getRazorpayInstance } from '../../../Payment/Razorpay/utils/razorpay-utils';
import { DELIVERY_REPORT_TAG } from './delivery-report.service';

const loggerCtx = 'DeliveryPaymentLinkService';

/** Payment Link expiry in seconds (30 minutes) */
const PAYMENT_LINK_EXPIRY_SECONDS = 1800;

export interface PaymentLinkResult {
    paymentLinkId: string;
    shortUrl: string;
    amount: number;
    status: string;
    customerPhone: string;
}

@Injectable()
export class DeliveryPaymentLinkService {
    constructor(
        private connection: TransactionalConnection,
        private fulfillmentService: FulfillmentService,
        private cacheService: CacheService,
    ) {}

    /**
     * Create a Razorpay Payment Link for COD payment collection via SMS.
     * Fulfillment must be in OutforDelivery state. Order must be COD.
     * Idempotent: cancels any existing active payment link before creating a new one.
     */
    async createPaymentLink(
        ctx: RequestContext,
        input: { fulfillmentId: ID; customerPhone: string },
    ): Promise<PaymentLinkResult> {
        const { fulfillment, order } = await this.loadFulfillmentWithOrder(ctx, input.fulfillmentId);

        if (fulfillment.state !== 'OutforDelivery') {
            throw new Error(`Fulfillment must be in OutforDelivery state, currently: ${fulfillment.state}`);
        }

        const isOnlinePayment = order.payments?.some(
            (p: any) => p.method === 'razorpay-payment' && (p.state === 'Settled' || p.state === 'Authorized'),
        );
        if (isOnlinePayment) {
            throw new Error('Order was paid online. No payment link needed.');
        }

        const orderTotal = (order.subTotalWithTax || 0) + (order.shippingWithTax || 0);

        // Validate phone number
        const phone = input.customerPhone.replace(/\s+/g, '');
        if (!/^[6-9]\d{9}$/.test(phone)) {
            throw new Error('Invalid Indian mobile number. Must be 10 digits starting with 6-9.');
        }

        // Cancel existing active payment link if any (idempotent regeneration)
        if (fulfillment.customFields?.paymentLinkId && fulfillment.customFields?.paymentLinkStatus === 'created') {
            await this.cancelPaymentLinkOnRazorpay(ctx, fulfillment.customFields.paymentLinkId);
        }

        // Get Razorpay SDK instance for this channel
        const razorpay = await this.getRazorpayInstanceForChannel(ctx);

        const expireBy = Math.floor(Date.now() / 1000) + PAYMENT_LINK_EXPIRY_SECONDS;

        const paymentLink = await razorpay.paymentLink.create({
            amount: orderTotal,
            currency: 'INR',
            reference_id: order.code,
            description: `Order #${order.code} - Delivery Payment`,
            customer: {
                contact: `+91${phone}`,
            },
            notify: {
                sms: true,
                email: false,
            },
            reminder_enable: true,
            expire_by: expireBy,
            notes: {
                fulfillmentId: String(input.fulfillmentId),
                orderId: String(order.id),
                orderCode: order.code,
                source: 'delivery-collection',
            },
        } as any);

        Logger.info(
            `Created Payment Link ${paymentLink.id} for fulfillment ${input.fulfillmentId}: ₹${orderTotal / 100} → +91${phone}`,
            loggerCtx,
        );

        // Save payment link fields on fulfillment
        fulfillment.customFields.paymentLinkId = paymentLink.id;
        fulfillment.customFields.paymentLinkShortUrl = paymentLink.short_url;
        fulfillment.customFields.paymentLinkStatus = 'created';
        fulfillment.customFields.paymentLinkPhone = phone;
        fulfillment.customFields.paymentLinkAmount = orderTotal;
        await this.connection.getRepository(ctx, 'Fulfillment').save(fulfillment);

        return {
            paymentLinkId: paymentLink.id,
            shortUrl: paymentLink.short_url,
            amount: orderTotal,
            status: 'created',
            customerPhone: phone,
        };
    }

    /**
     * Check Payment Link status via Razorpay API (polling fallback).
     * If paid, auto-transitions fulfillment to Delivered.
     */
    async checkPaymentLinkStatus(ctx: RequestContext, fulfillmentId: ID): Promise<PaymentLinkResult> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo.findOne({ where: { id: fulfillmentId } }) as any;

        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }

        const paymentLinkId = fulfillment.customFields?.paymentLinkId;
        if (!paymentLinkId) {
            throw new Error('No payment link found for this fulfillment');
        }

        // Already paid — just return result
        if (fulfillment.customFields?.paymentLinkStatus === 'paid') {
            return this.buildPaymentLinkResult(fulfillment);
        }

        const razorpay = await this.getRazorpayInstanceForChannel(ctx);
        const plData = await razorpay.paymentLink.fetch(paymentLinkId) as any;

        if (plData.status === 'paid') {
            Logger.info(`Payment Link ${paymentLinkId} paid. Auto-transitioning fulfillment ${fulfillmentId} to Delivered.`, loggerCtx);
            const razorpayPaymentId = plData.payments?.[0]?.payment_id || plData.id;
            await this.completePaymentLinkDelivery(ctx, fulfillment, razorpayPaymentId);
            fulfillment.customFields.paymentLinkStatus = 'paid';
        } else if (plData.status === 'cancelled' || plData.status === 'expired') {
            fulfillment.customFields.paymentLinkStatus = plData.status;
            await repo.save(fulfillment);
            Logger.info(`Payment Link ${paymentLinkId} ${plData.status}.`, loggerCtx);
        }

        return this.buildPaymentLinkResult(fulfillment);
    }

    /**
     * Cancel an active Payment Link.
     */
    async cancelPaymentLink(ctx: RequestContext, fulfillmentId: ID): Promise<{ paymentLinkId: string; status: string }> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo.findOne({ where: { id: fulfillmentId } }) as any;

        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }

        const paymentLinkId = fulfillment.customFields?.paymentLinkId;
        if (!paymentLinkId) {
            throw new Error('No payment link found for this fulfillment');
        }

        if (fulfillment.customFields?.paymentLinkStatus !== 'created') {
            throw new Error(`Payment link is already ${fulfillment.customFields?.paymentLinkStatus}`);
        }

        await this.cancelPaymentLinkOnRazorpay(ctx, paymentLinkId);

        fulfillment.customFields.paymentLinkStatus = 'cancelled';
        await repo.save(fulfillment);

        Logger.info(`Cancelled Payment Link ${paymentLinkId} for fulfillment ${fulfillmentId}`, loggerCtx);

        return { paymentLinkId, status: 'cancelled' };
    }

    /**
     * Handle Payment Link paid webhook from Razorpay (payment_link.paid event).
     * Called from RazorpayWebhookService.
     */
    async handlePaymentLinkWebhook(
        ctx: RequestContext,
        paymentLinkId: string,
        razorpayPaymentId: string,
        amount: number,
    ): Promise<void> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo
            .createQueryBuilder('f')
            .where('f.customFieldsPaymentlinkid = :paymentLinkId', { paymentLinkId })
            .getOne() as any;

        if (!fulfillment) {
            Logger.warn(`Payment Link webhook: No fulfillment found for ${paymentLinkId}`, loggerCtx);
            return;
        }

        if (fulfillment.customFields?.paymentLinkStatus !== 'created') {
            Logger.info(
                `Payment Link webhook: Fulfillment ${fulfillment.id} link already ${fulfillment.customFields?.paymentLinkStatus}. Skipping.`,
                loggerCtx,
            );
            return;
        }

        Logger.info(`Payment Link webhook: Payment confirmed for fulfillment ${fulfillment.id}. Auto-delivering.`, loggerCtx);
        await this.completePaymentLinkDelivery(ctx, fulfillment, razorpayPaymentId);
    }

    // ─── Private helpers ───

    /**
     * Complete delivery after Payment Link payment is confirmed.
     */
    private async completePaymentLinkDelivery(
        ctx: RequestContext,
        fulfillment: any,
        razorpayPaymentId: string,
    ): Promise<void> {
        const orderData = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .select('o.subTotalWithTax', 'subTotalWithTax')
            .addSelect('o.shippingWithTax', 'shippingWithTax')
            .where('f.id = :id', { id: fulfillment.id })
            .limit(1)
            .getRawOne();

        if (!orderData) {
            throw new Error(`Could not find order for fulfillment ${fulfillment.id}`);
        }

        const orderTotal = (parseInt(orderData.subTotalWithTax, 10) || 0)
            + (parseInt(orderData.shippingWithTax, 10) || 0);

        const phone = fulfillment.customFields?.paymentLinkPhone || '';
        const note = `Payment Link: Rs.${(orderTotal / 100).toFixed(2)} (${razorpayPaymentId}) -> +91${phone}`;

        // Load-then-save to properly persist custom fields
        // (createQueryBuilder().update().set() does not map customFields dot-notation to columns)
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const entity = await repo.findOne({ where: { id: fulfillment.id } }) as any;
        if (!entity) {
            throw new Error(`Fulfillment ${fulfillment.id} not found`);
        }
        entity.customFields = {
            ...entity.customFields,
            paymentCollectionMethod: 'PaymentLink',
            collectedAmount: orderTotal,
            collectionNote: note,
            deliveredAt: new Date(),
            paymentLinkStatus: 'paid',
        };
        await repo.save(entity);

        // Transition fulfillment to Delivered
        try {
            const result = await this.fulfillmentService.transitionToState(ctx, fulfillment.id, 'Delivered' as any);
            if (isGraphQlErrorResult(result)) {
                throw new Error((result as any).message || 'Failed to transition fulfillment to Delivered');
            }
            Logger.info(`Fulfillment ${fulfillment.id} auto-delivered after Payment Link payment ${razorpayPaymentId}`, loggerCtx);
            await this.cacheService.invalidateTags([DELIVERY_REPORT_TAG]);
        } catch (e: any) {
            Logger.error(`Failed to auto-deliver fulfillment ${fulfillment.id}: ${e.message}`, loggerCtx);
            throw e;
        }
    }

    private async loadFulfillmentWithOrder(ctx: RequestContext, fulfillmentId: ID) {
        const fulfillment = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .leftJoinAndSelect('f.lines', 'fl')
            .leftJoinAndSelect('fl.orderLine', 'ol')
            .leftJoinAndSelect('ol.order', 'o')
            .leftJoinAndSelect('o.payments', 'p')
            .where('f.id = :id', { id: fulfillmentId })
            .getOne() as any;

        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }

        const order = fulfillment.lines?.[0]?.orderLine?.order;
        if (!order) {
            throw new Error(`Could not find order for fulfillment ${fulfillmentId}`);
        }

        return { fulfillment, order };
    }

    private async getRazorpayInstanceForChannel(ctx: RequestContext) {
        const paymentMethod = await this.connection
            .getRepository(ctx, PaymentMethod)
            .createQueryBuilder('pm')
            .leftJoin('pm.channels', 'ch')
            .where('pm.code = :code', { code: 'razorpay-payment' })
            .andWhere('ch.id = :channelId', { channelId: ctx.channelId })
            .getOne();

        if (!paymentMethod) {
            throw new Error('Razorpay payment method not found for this channel');
        }

        const config = getRazorpayConfig(paymentMethod);
        if (!config) {
            throw new Error('Razorpay configuration not found');
        }

        return getRazorpayInstance({ key_id: config.key_id, key_secret: config.key_secret });
    }

    private async cancelPaymentLinkOnRazorpay(ctx: RequestContext, paymentLinkId: string): Promise<void> {
        try {
            const razorpay = await this.getRazorpayInstanceForChannel(ctx);
            await razorpay.paymentLink.cancel(paymentLinkId);
            Logger.info(`Cancelled Payment Link ${paymentLinkId} on Razorpay`, loggerCtx);
        } catch (e: any) {
            Logger.warn(`Could not cancel Payment Link ${paymentLinkId} on Razorpay: ${e.message}`, loggerCtx);
        }
    }

    private buildPaymentLinkResult(fulfillment: any): PaymentLinkResult {
        return {
            paymentLinkId: fulfillment.customFields?.paymentLinkId || '',
            shortUrl: fulfillment.customFields?.paymentLinkShortUrl || '',
            amount: fulfillment.customFields?.paymentLinkAmount || 0,
            status: fulfillment.customFields?.paymentLinkStatus || 'unknown',
            customerPhone: fulfillment.customFields?.paymentLinkPhone || '',
        };
    }
}
