import { Injectable } from '@nestjs/common';
import {
    Administrator,
    RequestContext,
    SettingsStoreService,
    TransactionalConnection,
} from '@vendure/core';
import axios from 'axios';
import { In } from 'typeorm';
import { CANCEL_ORDER_ALERT_KEY, CANCEL_ORDER_DEFAULT_ALERT_KEY } from '../constants';
import { normalizePhone } from '../functions/normalize-phone';
import { resolveAlertConfig, sanitizeNumbers } from '../functions/resolve-alert-config';
import { CancelOrderAlertConfig } from '../types';

@Injectable()
export class Msg91Service {
    // Auth key is a secret — never hardcode it. Missing env -> send is skipped (guard below).
    private readonly authKey = process.env.MSG91_AUTH_KEY || '';
    private readonly templateNamespace =
        process.env.MSG91_TEMPLATE_NAMESPACE || '1edcc486_2bee_46cf_b65f_1c7b21625d3f';

    constructor(
        private readonly settingsStore: SettingsStoreService,
        private readonly connection: TransactionalConnection,
    ) {}

    async sendOrderCancellationWhatsapp(
        ctx: RequestContext,
        customerMobile: string,
        customerName: string,
        orderCode: string,
    ): Promise<void> {
        const url = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

        if (!this.authKey) {
            console.error('[MSG91] MSG91_AUTH_KEY not set; skipping cancellation WhatsApp');
            return;
        }

        const config = await this.getAlertConfig(ctx);
        const helloNumber = config.helloNumber;
        // Admin ids are resolved to phone numbers at send time, so an admin who updates
        // their number starts receiving alerts without anyone re-editing the settings.
        const adminNumbers = await this.resolveAdminPhones(ctx, config.adminIds);
        const supportNumbers = Array.from(new Set([...adminNumbers, ...config.supportNumbers]));
        if (!supportNumbers.length) {
            console.error('[MSG91] No cancellation alert recipients configured; skipping send');
            return;
        }

        console.log(`[MSG91] Sending cancellation alert to ${supportNumbers.length} support team members`);
        console.log(`[MSG91] Customer: ${customerName} (${customerMobile}), Order: ${orderCode}`);
        console.log(`[MSG91] Sending FROM: ${helloNumber}`);

        const payload = {
            integrated_number: helloNumber,
            content_type: 'template',
            payload: {
                messaging_product: 'whatsapp',
                type: 'template',
                template: {
                    name: 'order_status_update',
                    language: {
                        code: 'en',
                        policy: 'deterministic',
                    },
                    namespace: this.templateNamespace,
                    to_and_components: [
                        {
                            to: supportNumbers,
                            components: {
                                body_1: {
                                    type: 'text',
                                    value: orderCode,
                                },
                                body_2: {
                                    type: 'text',
                                    value: 'CancellationRequested',
                                },
                                body_3: {
                                    type: 'text',
                                    value: `Cancellation requested by ${customerName}`,
                                },
                            },
                        },
                    ],
                },
            },
        };

        try {
            const response = await axios.post(url, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    authkey: this.authKey,
                },
            });
            console.log('[MSG91] ✅ WhatsApp sent to support team:', response.data);
        } catch (error: any) {
            console.error('[MSG91] ❌ Error:', error.response?.data || error.message);
        }
    }

    /**
     * Turns selected administrator ids into phone numbers. Soft-deleted admins and admins
     * with no phone number on file are dropped rather than failing the send — losing one
     * recipient must not cost the whole alert.
     */
    private async resolveAdminPhones(ctx: RequestContext, adminIds: string[]): Promise<string[]> {
        if (adminIds.length === 0) {
            return [];
        }
        try {
            const admins = await this.connection.getRepository(ctx, Administrator).find({
                where: { id: In(adminIds) },
            });
            const live = admins.filter(admin => !admin.deletedAt);
            const missing = adminIds.length - live.length;
            if (missing > 0) {
                console.warn(`[MSG91] ${missing} selected admin(s) missing or deleted; skipped`);
            }
            return sanitizeNumbers(
                live.map(admin => normalizePhone(String((admin.customFields as any)?.phoneNumber ?? ''))),
            );
        } catch (error: any) {
            console.error('[MSG91] Failed to resolve admin phone numbers:', error.message);
            return [];
        }
    }

    /**
     * Reads the channel's recipients and the shared default list in one round trip, then
     * layers them over env vars and the seed defaults. A SettingsStore read failure must
     * never block the alert, so it degrades to the remaining fallbacks.
     *
     * The channel key is scoped by `ctx.channel`, so this returns the list belonging to the
     * channel the cancellation was requested in.
     */
    private async getAlertConfig(ctx: RequestContext): Promise<CancelOrderAlertConfig> {
        const env = {
            helloNumber: process.env.MSG91_HELLO_NUMBER,
            supportNumbers: process.env.MSG91_SUPPORT_NUMBERS,
        };
        try {
            const stored = await this.settingsStore.getMany(ctx, [
                CANCEL_ORDER_ALERT_KEY,
                CANCEL_ORDER_DEFAULT_ALERT_KEY,
            ]);
            return resolveAlertConfig({
                channel: stored[CANCEL_ORDER_ALERT_KEY] as Partial<CancelOrderAlertConfig>,
                global: stored[CANCEL_ORDER_DEFAULT_ALERT_KEY] as Partial<CancelOrderAlertConfig>,
                env,
            });
        } catch (error: any) {
            console.error('[MSG91] Failed to read alert config from SettingsStore:', error.message);
            return resolveAlertConfig({ env });
        }
    }
}
