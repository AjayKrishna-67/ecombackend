import { LanguageCode, Logger, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';

import { TakeAwayPlugin } from '../../Shipping/take-away/take-away.plugin';
import { InvoiceNumberPlugin } from '../invoice-number/invoice-number.plugin';
import { ScheduledAvailabilityPlugin } from '../scheduled-availability/scheduled-availability.plugin';
import { ShippingMethodSmsTemplatePlugin } from '../shipping-method-sms-template/shipping-method-sms-template.plugin';
import { WhatsappController } from './api/whatsapp.controller';
import { WHATSAPP_BRANDS } from './brands';
import { loggerCtx, WHATSAPP_PLUGIN_OPTIONS } from './constants';
import { WhatsappLoginToken } from './entities/whatsapp-login-token.entity';
import { DeliveryBillPdfService } from './services/delivery-bill-pdf.service';
import { InvoicePdfService } from './services/invoice-pdf.service';
import { WhatsappLoginService } from './services/whatsapp-login.service';
import { WhatsappOrderService } from './services/whatsapp-order.service';
import { WhatsappService } from './services/whatsapp.service';
import { WhatsappPluginOptions } from './types';

/**
 * Replies to incoming WhatsApp messages with an "Order now" card. For Indian
 * numbers the button is a single-use link that logs the customer straight in
 * (see WhatsappAuthenticationStrategy, registered in vendure-config.ts).
 * Orders checked out through that login get an "order placed" WhatsApp
 * message, the store's location pin if it is a take-away order, and the
 * invoice PDF (see WhatsappOrderService).
 *
 * Webhook URL to register in Meta: https://<your-host>/whatsapp/webhook
 *
 * Requires the `beforeListen` json({ verify }) middleware in vendure-config.ts
 * to stash req.rawBody for this path, so the X-Hub-Signature-256 header can be
 * verified against the exact bytes Meta sent. (`nestApplicationOptions:
 * { rawBody: true }` does NOT work here: that middleware replaces Nest's own
 * body parser, which is what the rawBody option hooks into.)
 */
@VendurePlugin({
    // InvoiceNumberPlugin: its InvoiceNumberService numbers the order before the invoice PDF is sent.
    // TakeAwayPlugin: its TakeAwayOrderSnapshotService stores the pickup point the location pin uses.
    // ShippingMethodSmsTemplatePlugin: its OrderWhatsappService sends the MSG91 templates (brand.templates).
    // ScheduledAvailabilityPlugin: its ReportStorageService publishes the invoice PDF MSG91 fetches.
    imports: [
        PluginCommonModule,
        InvoiceNumberPlugin,
        TakeAwayPlugin,
        ShippingMethodSmsTemplatePlugin,
        ScheduledAvailabilityPlugin,
    ],
    controllers: [WhatsappController],
    entities: [WhatsappLoginToken],
    providers: [
        { provide: WHATSAPP_PLUGIN_OPTIONS, useFactory: () => WhatsappPlugin.options },
        WhatsappService,
        WhatsappLoginService,
        WhatsappOrderService,
        InvoicePdfService,
        DeliveryBillPdfService,
    ],
    configuration: config => {
        config.customFields.Order.push({
            name: 'placedViaWhatsapp',
            type: 'boolean',
            defaultValue: false,
            public: false,
            readonly: true,
            label: [{ languageCode: LanguageCode.en, value: 'Placed via WhatsApp' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Customer checked out after logging in through a WhatsApp link; they get an order-placed WhatsApp message.',
                },
            ],
        });
        return config;
    },
    compatibility: '^3.0.0',
})
export class WhatsappPlugin {
    static options: WhatsappPluginOptions;

    static init(options: WhatsappPluginOptions): Type<WhatsappPlugin> {
        this.options = options;
        WhatsappPlugin.validateOptions(options);
        return WhatsappPlugin;
    }

    /**
     * Logs each problem instead of throwing: this project's pm2 deploy reports a
     * crashed boot as healthy, so a throw here would silently take the whole
     * shop API down rather than just degrade WhatsApp messaging.
     */
    private static validateOptions(options: WhatsappPluginOptions): void {
        if (!options.appSecret) {
            Logger.error(
                'WhatsappPlugin: appSecret is empty — webhook signatures cannot be verified — all webhook POSTs will be rejected',
                loggerCtx,
            );
        }
        const brand = WHATSAPP_BRANDS[options.brand];
        if (brand?.sendVia === 'msg91' && (!options.msg91?.authKey || !options.msg91.integratedNumber)) {
            Logger.error(
                'WhatsappPlugin: MSG91_AUTH_KEY / MSG91_HELLO_NUMBER is empty — this brand sends through MSG91, so replies cannot be sent',
                loggerCtx,
            );
        }
        if (!brand) {
            Logger.error(
                `WhatsappPlugin: brand "${options.brand}" is unknown (set WA_BRAND to one of ${Object.keys(WHATSAPP_BRANDS).join(', ')}) — replies cannot be sent`,
                loggerCtx,
            );
        }
        if (!options.accessToken && brand?.sendVia !== 'msg91') {
            Logger.error('WhatsappPlugin: accessToken is empty — replies cannot be sent', loggerCtx);
        }
        try {
            new URL(options.storeUrl);
        } catch {
            Logger.error(
                `WhatsappPlugin: storeUrl "${options.storeUrl}" is invalid — Order now links cannot be built`,
                loggerCtx,
            );
        }
    }
}
