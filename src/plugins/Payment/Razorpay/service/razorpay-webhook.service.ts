// src/plugins/Payment/Razorpay/service/razorpay-webhook.service.ts
import { Injectable } from '@nestjs/common';
import {
    TransactionalConnection, OrderService, RequestContextService,
    Order, Logger, HistoryService, PaymentMethod,
    FulfillmentService, RequestContext,
} from '@vendure/core';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { findMatchingWebhookSecret } from '../utils/razorpay-utils';
import { getRazorpayConfig } from '../utils/config-helper';
import { RAZORPAY_WEBHOOK_TYPE, RazorpayWebhookOutcome } from '../types';
import { RazorpaySettlementService } from './razorpay-settlement.service';

@Injectable()
export class RazorpayWebhookService {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private requestContextService: RequestContextService,
        private historyService: HistoryService,
        private fulfillmentService: FulfillmentService,
        private settlementService: RazorpaySettlementService,
    ) {}

    /**
     * Entry point for every stored webhook. The signature is checked once, here,
     * before any event type is routed: nothing (settlement, QR / payment-link
     * delivery, payment.failed revert) acts on an unverified body.
     */
    async processWebhook(signature: string, body: any, rawBody: string): Promise<RazorpayWebhookOutcome> {
        if (!(await this.isSignatureValid(rawBody, signature, body))) {
            return 'invalid-signature';
        }
        await this.handleVerifiedWebhook(body);
        return 'processed';
    }

    /**
     * Accepts the webhook when its HMAC matches the webhook secret of ANY
     * razorpay-payment method (enabled or not): a secret proves the Razorpay
     * account, while routing below still uses the order's own channel. Fails
     * closed when no secret is configured anywhere.
     */
    private async isSignatureValid(rawBody: string, signature: string, body: any): Promise<boolean> {
        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        const methods = await this.connection.getRepository(ctx, PaymentMethod).find({
            where: { code: 'razorpay-payment' },
        });
        const secrets = [...new Set(methods.map(m => getRazorpayConfig(m)?.webhook_secret).filter((s): s is string => !!s))];
        const label = `event=${body?.event} rzpOrder=${body?.payload?.payment?.entity?.order_id ?? body?.payload?.order?.entity?.id ?? 'n/a'}`;
        if (!secrets.length) {
            Logger.error(`[WEBHOOK-NO-SECRETS] No razorpay-payment method has a webhook secret; refusing ${label}`, 'RazorpayPlugin');
            return false;
        }
        if (findMatchingWebhookSecret(rawBody, signature, secrets) === -1) {
            Logger.error(`[WEBHOOK-SIGNATURE-INVALID] ${label}`, 'RazorpayPlugin');
            return false;
        }
        return true;
    }

    private async handleVerifiedWebhook(body: any): Promise<void> {
    const rzpOrderId = body.payload.payment?.entity?.order_id || body.payload.order?.entity?.id;
    const razorpayPaymentId = body.payload.payment?.entity?.id;
    const webhookEvent = body.event;

    Logger.info(`[Webhook] Received event: ${webhookEvent} for Razorpay Order ID: ${rzpOrderId}`, 'RazorpayPlugin');

    // ─── QR CODE PAYMENT HANDLING (delivery collection) ───
    if (webhookEvent === 'qr_code.credited') {
        const qrCodeId = body.payload.qr_code?.entity?.id;
        const qrPaymentId = body.payload.payment?.entity?.id || body.payload.qr_code?.entity?.payments?.[0]?.payment_id;
        const qrAmount = body.payload.payment?.entity?.amount || body.payload.qr_code?.entity?.payments_amount_received;
        Logger.info(`[Webhook] QR code credited: ${qrCodeId}, payment: ${qrPaymentId}, amount: ${qrAmount}`, 'RazorpayPlugin');
        if (!qrCodeId) {
            Logger.warn('[Webhook] QR credited event missing qr_code ID. Skipping.', 'RazorpayPlugin');
            return;
        }
        // Find fulfillment by qrCodeId to determine channel
        const adminCtx = await this.requestContextService.create({ apiType: 'admin' });
        const fulfillment = await this.connection.getRepository(adminCtx, 'Fulfillment')
            .createQueryBuilder('f')
            .leftJoinAndSelect('f.lines', 'fl')
            .leftJoinAndSelect('fl.orderLine', 'ol')
            .leftJoinAndSelect('ol.order', 'o')
            .leftJoin('o.channels', 'ch')
            .addSelect('ch.id')
            .addSelect('ch.token')
            .addSelect('ch.code')
            .where('f.customFieldsQrcodeid = :qrCodeId', { qrCodeId })
            .getOne() as any;
        if (!fulfillment) {
            Logger.warn(`[Webhook] No fulfillment found for QR ${qrCodeId}. May not be a delivery QR.`, 'RazorpayPlugin');
            return;
        }
        if (fulfillment.customFields?.qrCodeStatus !== 'active') {
            Logger.info(`[Webhook] QR ${qrCodeId} already ${fulfillment.customFields?.qrCodeStatus}. Skipping.`, 'RazorpayPlugin');
            return;
        }
        // Resolve channel from the fulfillment's order
        const order = fulfillment.lines?.[0]?.orderLine?.order;
        const orderChannels = order?.channels || [];
        const orderChannel = orderChannels.find((c: any) => c.code !== '__default_channel__') || orderChannels[0];
        let channelCtx = adminCtx;
        if (orderChannel?.token) {
            channelCtx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: orderChannel.token,
            });
        }
        // Complete the delivery via QR payment (signature already verified in processWebhook)
        const qrAmountNum = typeof qrAmount === 'number' ? qrAmount : parseInt(qrAmount, 10) || 0;
        const orderTotal = (order?.subTotalWithTax || 0) + (order?.shippingWithTax || 0);
        const cashAmount = fulfillment.customFields?.qrCashAmount || 0;
        const qrPortionAmount = fulfillment.customFields?.qrAmount || 0;
        const collectionMethod = cashAmount > 0 ? 'Cash+QR' : 'QR';
        const noteParts: string[] = [];
        if (cashAmount > 0) noteParts.push(`Cash: Rs.${(cashAmount / 100).toFixed(2)}`);
        noteParts.push(`QR: Rs.${(qrPortionAmount / 100).toFixed(2)} (${qrPaymentId || qrCodeId})`);
        // Update fulfillment custom fields
        const repo = this.connection.getRepository(channelCtx, 'Fulfillment');
        const entity = await repo.findOne({ where: { id: fulfillment.id } });
        if (entity) {
            (entity as any).customFields.qrCodeStatus = 'paid';
            (entity as any).customFields.paymentCollectionMethod = collectionMethod;
            (entity as any).customFields.collectedAmount = orderTotal;
            (entity as any).customFields.collectionNote = noteParts.join(', ');
            (entity as any).customFields.deliveredAt = new Date();
            await repo.save(entity);
        }
        // Transition fulfillment to Delivered (subscriber auto-transitions order)
        try {
            await this.fulfillmentService.transitionToState(channelCtx, fulfillment.id, 'Delivered' as any);
            Logger.info(`[Webhook] QR payment: Fulfillment ${fulfillment.id} auto-delivered`, 'RazorpayPlugin');
        } catch (e: any) {
            Logger.error(`[Webhook] Failed to auto-deliver fulfillment ${fulfillment.id}: ${e.message}`, 'RazorpayPlugin');
        }
        return;
    }

    // ─── PAYMENT LINK PAYMENT HANDLING (delivery collection via SMS link) ───
    if (webhookEvent === 'payment_link.paid') {
        const paymentLinkId = body.payload.payment_link?.entity?.id;
        const plPaymentId = body.payload.payment?.entity?.id || body.payload.payment_link?.entity?.payments?.[0]?.payment_id;
        const plAmount = body.payload.payment?.entity?.amount || body.payload.payment_link?.entity?.amount;
        const plNotes = body.payload.payment_link?.entity?.notes;

        Logger.info(`[Webhook] Payment Link paid: ${paymentLinkId}, payment: ${plPaymentId}, amount: ${plAmount}`, 'RazorpayPlugin');

        // Only handle delivery-collection payment links (not regular checkout links)
        if (!plNotes?.source || plNotes.source !== 'delivery-collection') {
            Logger.info(`[Webhook] Payment Link ${paymentLinkId} is not a delivery collection link. Skipping.`, 'RazorpayPlugin');
            // Fall through to regular order handling below
        } else {
            if (!paymentLinkId) {
                Logger.warn('[Webhook] Payment Link paid event missing payment_link ID. Skipping.', 'RazorpayPlugin');
                return;
            }

            // Find fulfillment by paymentLinkId to determine channel
            const adminCtx = await this.requestContextService.create({ apiType: 'admin' });
            const fulfillment = await this.connection.getRepository(adminCtx, 'Fulfillment')
                .createQueryBuilder('f')
                .leftJoinAndSelect('f.lines', 'fl')
                .leftJoinAndSelect('fl.orderLine', 'ol')
                .leftJoinAndSelect('ol.order', 'o')
                .leftJoin('o.channels', 'ch')
                .addSelect('ch.id')
                .addSelect('ch.token')
                .addSelect('ch.code')
                .where('f.customFieldsPaymentlinkid = :paymentLinkId', { paymentLinkId })
                .getOne() as any;

            if (!fulfillment) {
                Logger.warn(`[Webhook] No fulfillment found for Payment Link ${paymentLinkId}.`, 'RazorpayPlugin');
                return;
            }

            if (fulfillment.customFields?.paymentLinkStatus !== 'created') {
                Logger.info(`[Webhook] Payment Link ${paymentLinkId} already ${fulfillment.customFields?.paymentLinkStatus}. Skipping.`, 'RazorpayPlugin');
                return;
            }

            // Resolve channel from the fulfillment's order
            const order = fulfillment.lines?.[0]?.orderLine?.order;
            const orderChannels = order?.channels || [];
            const orderChannel = orderChannels.find((c: any) => c.code !== '__default_channel__') || orderChannels[0];
            let channelCtx = adminCtx;
            if (orderChannel?.token) {
                channelCtx = await this.requestContextService.create({
                    apiType: 'admin',
                    channelOrToken: orderChannel.token,
                });
            }

            // Complete the delivery via Payment Link payment (signature already verified in processWebhook)
            const orderTotal = (order?.subTotalWithTax || 0) + (order?.shippingWithTax || 0);
            const phone = fulfillment.customFields?.paymentLinkPhone || '';
            const note = `Payment Link: Rs.${(orderTotal / 100).toFixed(2)} (${plPaymentId || paymentLinkId}) -> +91${phone}`;

            // Update fulfillment custom fields
            const repo = this.connection.getRepository(channelCtx, 'Fulfillment');
            const entity = await repo.findOne({ where: { id: fulfillment.id } });
            if (entity) {
                (entity as any).customFields.paymentLinkStatus = 'paid';
                (entity as any).customFields.paymentCollectionMethod = 'PaymentLink';
                (entity as any).customFields.collectedAmount = orderTotal;
                (entity as any).customFields.collectionNote = note;
                (entity as any).customFields.deliveredAt = new Date();
                await repo.save(entity);
            }

            // Transition fulfillment to Delivered
            try {
                await this.fulfillmentService.transitionToState(channelCtx, fulfillment.id, 'Delivered' as any);
                Logger.info(`[Webhook] Payment Link: Fulfillment ${fulfillment.id} auto-delivered`, 'RazorpayPlugin');
            } catch (e: any) {
                Logger.error(`[Webhook] Failed to auto-deliver fulfillment ${fulfillment.id}: ${e.message}`, 'RazorpayPlugin');
            }
            return;
        }
    }

    // ─── EVENTS WE DON'T PROCESS ─────────────────────────────────────
    // These events are sent by Razorpay but don't require any action on
    // our side. Return silently instead of throwing "Missing Order ID".
    const ignoredEvents = [
        'qr_code.created',   // informational — we already know, we created it
        'qr_code.closed',    // handled by polling sweep, not webhook
        'payment.downtime.started',   // Razorpay UPI infra notification
        'payment.downtime.resolved',  // Razorpay UPI infra notification
    ];
    if (ignoredEvents.includes(webhookEvent)) {
        Logger.debug(`[Webhook] Ignoring ${webhookEvent} event (no action needed)`, 'RazorpayPlugin');
        return;
    }

    if (!rzpOrderId) {
        throw new Error('Missing Razorpay Order ID in webhook payload');
    }

    // --- 1. FAILURE HANDLING: Do not settle order on payment failure ---
    if (webhookEvent === 'payment.failed') {
        Logger.warn(`[Webhook] Payment FAILED for Razorpay Order ${rzpOrderId}. Verifying no other attempt succeeded...`, 'RazorpayPlugin');

        const adminCtx = await this.requestContextService.create({ apiType: 'admin' });
        const orderForHistory = await this.connection.getRepository(adminCtx, Order).findOne({
            where: { customFields: { razorpayOrderId: rzpOrderId } as any },
            relations: ['channels', 'payments'],
        });

        if (!orderForHistory) {
            return;
        }

        // GUARD: A Razorpay order allows MULTIPLE payment attempts. A `payment.failed`
        // event for one attempt does NOT mean the order failed — a later attempt may
        // have been captured. Let the single settlement path decide from Razorpay's
        // authoritative state; it settles if a captured/authorized payment exists and
        // reports 'no-capture' only when the order genuinely has no money.
        const channelCtx = await this.settlementService.resolveChannelContext(orderForHistory);
        const client = await this.settlementService.getRazorpayClientForCtx(channelCtx);
        if (client) {
            const freshOrder = await this.connection.getRepository(channelCtx, Order).findOne({
                where: { id: orderForHistory.id },
                relations: ['channels', 'payments'],
            });
            if (freshOrder) {
                const result = await this.settlementService.settleFromRazorpay(
                    channelCtx, freshOrder, client, 'Razorpay Webhook (failed->recovered)');
                if (result.status === 'settled' || result.status === 'authorized' || result.status === 'already') {
                    Logger.warn(`[Webhook] payment.failed for ${orderForHistory.code} but a captured/authorized payment existed — settled instead of failing.`, 'RazorpayPlugin');
                    return;
                }
            }
        }

        // NO revert here. A failed attempt is not a closed checkout: with Razorpay's
        // `retry` the customer is still on the payment page and may pay on the next
        // attempt, and reverting now made the app's addPaymentToOrder fail after a
        // successful retry. The cart is released only when the checkout actually
        // closes (cancelRazorpayPayment from modal.ondismiss) or times out
        // (reconciliation), both gated on Razorpay reporting 'unpaid'.

        await this.historyService.createHistoryEntryForOrder({
            ctx: adminCtx,
            orderId: orderForHistory.id,
            type: RAZORPAY_WEBHOOK_TYPE,
            data: {
                webhookEvent,
                source: 'Razorpay Webhook',
                paymentId: razorpayPaymentId || '',
                razorpayOrderId: rzpOrderId,
                amount: body.payload.payment?.entity?.amount || 0,
                status: 'Failed',
                timestamp: new Date().toISOString(),
            }
        }, false);
        return; // Stop processing here so the order is not settled
    }

    // --- 2. EVENT FILTERING: Only allow success events to proceed ---
    const successEvents = ['payment.authorized', 'payment.captured', 'order.paid'];
    if (!successEvents.includes(webhookEvent)) {
        Logger.info(`[Webhook] Ignoring non-settlement event: ${webhookEvent}`, 'RazorpayPlugin');
        return;
    }

    // 1. GLOBAL LOOKUP: Resolve channel token from order metadata
    const adminCtx = await this.requestContextService.create({ apiType: 'admin' });
    let order = await this.connection.getRepository(adminCtx, Order).findOne({
        where: { customFields: { razorpayOrderId: rzpOrderId } as any },
        relations: ['channels', 'payments']
    });

    // FALLBACK LOOKUP: the primary join above is on the `razorpayOrderId` custom field,
    // which the APP writes onto the order AFTER creating the Razorpay order. If the app
    // crashed or lost connectivity between capture and that write, the field stays empty
    // and this capture webhook can't find the order — money is taken but the order is
    // orphaned (the "Order not found" dead-letters). Razorpay stamps the order at
    // creation with an immutable `notes.vendureOrderId`, so recover the order directly
    // by primary key. settleFromRazorpay remains the authority on whether/how to settle
    // (idempotent no-op if the order is already placed).
    if (!order) {
        const notesVendureOrderId =
            body.payload.payment?.entity?.notes?.vendureOrderId ??
            body.payload.order?.entity?.notes?.vendureOrderId;
        if (notesVendureOrderId) {
            order = await this.connection.getRepository(adminCtx, Order).findOne({
                where: { id: notesVendureOrderId as any },
                relations: ['channels', 'payments'],
            });
            if (order) {
                Logger.warn(`[Webhook] Order not linked by razorpayOrderId ${rzpOrderId}; recovered via notes.vendureOrderId=${notesVendureOrderId} -> ${order.code}. Backfilling link.`, 'RazorpayPlugin');
                // Backfill the missing link so the other two events for this payment
                // (authorized / captured / order.paid all fire) and the reconciliation
                // cron find this order by the fast primary path instead of notes.
                await this.orderService.updateCustomFields(adminCtx, order.id, {
                    razorpayOrderId: rzpOrderId,
                } as any);
            }
        }
    }

    if (!order) {
        Logger.warn(`[Webhook] Order not found for Razorpay ID: ${rzpOrderId} (no razorpayOrderId link and no notes.vendureOrderId)`, 'RazorpayPlugin');
        throw new Error(`Order ${rzpOrderId} not found`);
    }

    Logger.info(`[Webhook] Found Order ${order.code} in state: ${order.state}`, 'RazorpayPlugin');

    // Check for duplicate payment by transaction ID
    if (razorpayPaymentId) {
        const existingPayment = order.payments?.find(p => p.transactionId === razorpayPaymentId);
        if (existingPayment) {
            Logger.info(`[Webhook] Payment ${razorpayPaymentId} already exists for Order ${order.code}. Skipping duplicate.`, 'RazorpayPlugin');
            return;
        }
    }

    // 2. CHANNEL BINDING: Use order's specific channel
    const orderChannel = order.channels.find(c => c.code !== '__default_channel__') || order.channels[0];

    if (!orderChannel) {
        throw new Error(`Order ${order.code} has no valid channel associated`);
    }

    const ctx = await this.requestContextService.create({
        apiType: 'admin',
        channelOrToken: orderChannel.token,
    });

    // 3. REFETCH ORDER (signature already verified in processWebhook): Get the latest state before settlement
    const freshOrder = await this.connection.getRepository(ctx, Order).findOne({
        where: { id: order.id },
        relations: ['channels', 'payments']
    });

    if (!freshOrder) {
        throw new Error(`Order ${order.code} not found during refetch`);
    }

    Logger.info(`[Webhook] Refetched Order ${freshOrder.code}, current state: ${freshOrder.state}`, 'RazorpayPlugin');

    // 4. SETTLEMENT via the single source of truth (idempotent + atomic).
    const client = await this.settlementService.getRazorpayClientForCtx(ctx);
    if (!client) {
        throw new Error(`Razorpay client unavailable for channel ${orderChannel.code}`);
    }
    const result = await this.settlementService.settleFromRazorpay(ctx, freshOrder, client, 'Razorpay Webhook');
    // Do NOT let a non-settlement masquerade as a processed webhook. `settled` /
    // `authorized` / `already` / `no-capture` / `terminal` are all resolved outcomes —
    // return quietly (the queue marks the event processed). But `incomplete` (money
    // captured, order stuck in a pre-payment state) and `error` (transient) must THROW:
    // the queue then records the event as failed + retries, and retries can self-heal
    // `incomplete` if the cart gets completed in the meantime. The MONEY-STUCK-ALERT is
    // already emitted inside settleFromRazorpay for the `incomplete` case.
    if (result.status === 'incomplete') {
        throw new Error(`MONEY_STUCK: ${freshOrder.code} captured at Razorpay but not settleable (state=${freshOrder.state})`);
    }
    if (result.status === 'error') {
        throw new Error(`Settlement failed for ${freshOrder.code} (transient) — will retry`);
    }
    if (result.status === 'already' && webhookEvent === 'payment.captured' && razorpayPaymentId) {
        await this.flagDuplicateCapture(ctx, freshOrder, razorpayPaymentId, Number(body.payload.payment?.entity?.amount ?? 0));
    }
}

    /**
     * A captured payment arrived for an order that was already paid, and it is not
     * one of the order's recorded payments: the customer paid twice (e.g. two UPI
     * apps). Nothing in Vendure will ever use this money, so staff must refund it.
     * Uses only data the webhook already has — no Razorpay API call (D20).
     */
    private async flagDuplicateCapture(ctx: RequestContext, order: Order, paymentId: string, amount: number): Promise<void> {
        const latest = await this.connection.getRepository(ctx, Order).findOne({
            where: { id: order.id },
            relations: ['payments'],
        });
        if (latest?.payments?.some(p => p.transactionId === paymentId)) {
            return;
        }
        Logger.error(`[DUPLICATE-CAPTURE] order=${order.code} payment=${paymentId} amount=${amount} — order already paid; refund this payment`, 'RazorpayPlugin');
        try {
            await this.historyService.createHistoryEntryForOrder({
                ctx,
                orderId: order.id,
                type: HistoryEntryType.ORDER_NOTE,
                data: {
                    note: `Duplicate payment: Razorpay payment ${paymentId} (₹${(amount / 100).toFixed(2)}) was captured after this order was already paid. ` +
                        `Refund it from the Razorpay dashboard.`,
                },
            }, false);
        } catch { /* history is non-critical */ }
    }
}