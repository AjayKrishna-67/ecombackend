import { Body, Controller, Headers, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import { Logger, RequestContextService } from '@vendure/core';
import { timingSafeEqual } from 'crypto';
import { Response } from 'express';

import { ADLOGGS_PLUGIN_OPTIONS, ADLOGGS_WEBHOOK_TOKEN_HEADER, loggerCtx } from '../constants';
import { AdloggsFulfillmentService } from '../fulfillment/adloggs-fulfillment.service';
import { AdloggsWebhookPayload, ADLOGGS_STATUS_LABELS, PluginInitOptions } from '../types';

/**
 * Receives Adloggs order-status webhooks.
 *
 * URL to register with Adloggs:  https://<api-host>/adloggs/webhook
 * Auth: Adloggs must send header  x-webhook-token: <ADLOGGS_WEBHOOK_TOKEN>
 *
 * Status updates are idempotent (re-applying the same order_status_id is a
 * no-op), so unlike the Razorpay webhook no dedup table or queue is needed —
 * the handler is a couple of DB writes and runs fine without the worker.
 *
 * Lookup is uuid-first with a partner_order_id fallback: Adloggs error
 * responses have been observed to swallow the create response while still
 * creating the order, so the first webhook for such an order is also how we
 * learn its uuid (see AdloggsFulfillmentService.attachUuidByPartnerOrderId).
 */
@Controller('adloggs')
export class AdloggsWebhookController {
    constructor(
        @Inject(ADLOGGS_PLUGIN_OPTIONS) private options: PluginInitOptions,
        private requestContextService: RequestContextService,
        private adloggsFulfillmentService: AdloggsFulfillmentService,
    ) {}

    @Post('webhook')
    async handleWebhook(
        @Headers(ADLOGGS_WEBHOOK_TOKEN_HEADER) token: string | undefined,
        @Body() body: AdloggsWebhookPayload,
        @Res() res: Response,
    ) {
        if (!this.tokenIsValid(token)) {
            Logger.warn('Adloggs webhook rejected: bad or missing token', loggerCtx);
            return res.status(HttpStatus.UNAUTHORIZED).json({ success: false, error: 'Invalid token' });
        }
        if (!body?.order_uuid || !body?.order_status_id) {
            return res.status(HttpStatus.BAD_REQUEST).json({ success: false, error: 'order_uuid and order_status_id are required' });
        }

        const label = ADLOGGS_STATUS_LABELS[body.order_status_id] ?? `status ${body.order_status_id}`;
        Logger.info(
            `Adloggs webhook: ${label} for ${body.partner_order_id || body.order_uuid}`,
            loggerCtx,
        );

        try {
            const ctx = await this.requestContextService.create({ apiType: 'admin' });

            let fulfillment = await this.adloggsFulfillmentService.findFulfillmentByUuid(ctx, body.order_uuid);
            if (!fulfillment && body.partner_order_id) {
                fulfillment = await this.adloggsFulfillmentService.attachUuidByPartnerOrderId(
                    ctx,
                    body.partner_order_id,
                    body.order_uuid,
                );
            }
            if (!fulfillment) {
                // Answer 200 so Adloggs does not retry forever; the mismatch is logged.
                Logger.warn(
                    `Adloggs webhook for unknown order (uuid=${body.order_uuid}, partner_order_id=${body.partner_order_id})`,
                    loggerCtx,
                );
                return res.status(HttpStatus.OK).json({ success: true, ignored: true });
            }

            const result = await this.adloggsFulfillmentService.applyStatusUpdate(ctx, fulfillment.id, {
                statusId: body.order_status_id,
                rider: body.deliveryStaffDetails,
                deliveryOtp: body.otps?.delivery_otp,
            });
            return res.status(HttpStatus.OK).json({ success: result.success, message: result.message });
        } catch (error: any) {
            Logger.error(`Adloggs webhook processing failed: ${error.message}`, loggerCtx, error.stack);
            return res
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .json({ success: false, error: 'Internal error' });
        }
    }

    private tokenIsValid(token: string | undefined): boolean {
        const expected = this.options.webhookToken;
        if (!expected) {
            // No token configured — endpoint disabled until setup is complete.
            return false;
        }
        if (!token) {
            return false;
        }
        const a = Buffer.from(token);
        const b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
    }
}
