// src/plugins/Payment/Razorpay/service/razorpay-webhook.controller.ts

import { Controller, Post, Headers, Body, Req, Res, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { TransactionalConnection, RequestContextService, Logger } from '@vendure/core';
import { RazorpayWebhookEvent } from '../entities/razorpay-webhook-event.entity';
import { RazorpaySettleQueueService } from './razorpay-settle-queue.service';

@Controller('shop-api/razorpay')
export class RazorpayWebhookController {
    constructor(
        private connection: TransactionalConnection,
        private requestContextService: RequestContextService,
        private settleQueue: RazorpaySettleQueueService,
    ) {}

    /**
     * Razorpay Webhook Endpoint
     * URL: https://api.yoursite.com/shop-api/razorpay/webhook
     *
     * Durable, async design:
     * - Capture raw bytes (beforeListen middleware) for exact-signature verify.
     * - Persist the event to `razorpay_webhook_event` — the unique `eventId`
     *   column is the idempotency guarantee (survives cache eviction).
     * - Return 202 immediately; a worker job resolves the channel, verifies the
     *   signature over the stored raw bytes, and settles/routes.
     * This keeps the HTTP handler to a couple of DB writes and makes processing
     * durable + retryable instead of racing inside the request.
     */
    @Post('webhook')
    async handleWebhook(
        @Headers('x-razorpay-signature') signature: string,
        @Headers('x-razorpay-event-id') eventIdHeader: string,
        @Body() body: any,
        @Req() req: Request,
        @Res() res: Response
    ) {
        // Raw bytes captured by the beforeListen json({ verify }) middleware in
        // vendure-config.ts. Fall back to a re-stringify only if the middleware
        // did not run (should not happen for this route).
        const rawBody: string = (req as any).rawBody
            ? (req as any).rawBody.toString('utf8')
            : JSON.stringify(body);
        const webhookEvent = body?.event || 'unknown';
        const rzpOrderId = body?.payload?.payment?.entity?.order_id
            || body?.payload?.order?.entity?.id
            || body?.payload?.qr_code?.entity?.id
            || body?.payload?.payment_link?.entity?.id;
        const rzpPaymentId = body?.payload?.payment?.entity?.id;

        Logger.info(`[Webhook Controller] Received ${webhookEvent} for Razorpay Order: ${rzpOrderId}`, 'RazorpayPlugin');

        if (!signature) {
            Logger.error('[Webhook Controller] Missing x-razorpay-signature header', 'RazorpayPlugin');
            return res.status(HttpStatus.BAD_REQUEST).json({ success: false, error: 'Missing signature header' });
        }
        if (!body) {
            Logger.error('[Webhook Controller] Invalid webhook payload - empty body', 'RazorpayPlugin');
            return res.status(HttpStatus.BAD_REQUEST).json({ success: false, error: 'Invalid payload' });
        }

        // Idempotency key. Prefer Razorpay's per-event id; then payment id; then
        // event:order; finally a hash of the raw body so it is never null and
        // identical re-deliveries always collide.
        const dedupId: string = eventIdHeader
            || rzpPaymentId
            || (rzpOrderId ? `${webhookEvent}:${rzpOrderId}` : '')
            || createHash('sha256').update(rawBody).digest('hex');

        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        const repo = this.connection.getRepository(ctx, RazorpayWebhookEvent);

        // DB-level dedup: if this event id already exists, it was already received.
        const existing = await repo.findOne({ where: { eventId: dedupId } });
        if (existing) {
            Logger.info(`[Webhook Controller] Duplicate ${webhookEvent} (id=${dedupId}) ignored`, 'RazorpayPlugin');
            return res.status(HttpStatus.OK).json({ success: true, message: 'Duplicate webhook ignored' });
        }

        try {
            await repo.save(repo.create({
                eventId: dedupId,
                event: webhookEvent,
                rzpOrderId: rzpOrderId || undefined,
                rzpPaymentId: rzpPaymentId || undefined,
                rawPayload: rawBody,
                signature,
                status: 'received',
            }));
        } catch (e: any) {
            // Unique-constraint violation from a concurrent duplicate delivery.
            Logger.info(`[Webhook Controller] Concurrent duplicate ${webhookEvent} (id=${dedupId}) ignored`, 'RazorpayPlugin');
            return res.status(HttpStatus.OK).json({ success: true, message: 'Duplicate webhook ignored' });
        }

        // Hand off to the worker. If enqueue fails, the row stays 'received' and
        // the reconciliation sweep is the backstop — never lose a paid order.
        try {
            await this.settleQueue.enqueue(dedupId);
        } catch (e: any) {
            Logger.error(`[Webhook Controller] Failed to enqueue ${dedupId}: ${e.message}. Reconciliation will backstop.`, 'RazorpayPlugin');
        }

        return res.status(HttpStatus.ACCEPTED).json({ success: true, message: 'Webhook accepted' });
    }
}
