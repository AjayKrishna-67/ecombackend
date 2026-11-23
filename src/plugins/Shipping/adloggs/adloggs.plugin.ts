import { LanguageCode, PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

import { AdloggsAdminResolver } from './api/adloggs-admin.resolver';
import { AdloggsWebhookController } from './api/adloggs-webhook.controller';
import { adminApiExtensions } from './api/api-extensions';
import { ADLOGGS_PLUGIN_OPTIONS } from './constants';
import { AdloggsFulfillmentService } from './fulfillment/adloggs-fulfillment.service';
import { AdloggsFulfillmentSubscriber } from './fulfillment/adloggs-fulfillment.subscriber';
import { AdloggsService } from './services/adloggs.service';
import { adloggsCalculator } from './shipping/adloggs-calculator';
import { PluginInitOptions } from './types';

/**
 * AdloggsPlugin — hyperlocal rider delivery via the Adloggs partner API
 * (see ADLOGGS_DOCUMENTATION.md in this folder).
 *
 * • Quoting     — `adloggs-calculator` quotes the live Adloggs fee at checkout
 *                 (availability API; pickup point from the calculator's own
 *                 arguments → customer's address map pin).
 * • Fulfillment — the KaaiKani fulfillment handler's "Adloggs" option stamps
 *                 fulfillmentType "adloggs"; the subscriber then creates the
 *                 Adloggs order and stores uuid/fee/track URL on the
 *                 fulfillment. Cancelling the order or fulfillment cancels the
 *                 Adloggs order (until pickup — their API refuses after).
 * • Tracking    — Adloggs POSTs status webhooks to /adloggs/webhook; statuses
 *                 walk the fulfillment through Shipped → OutforDelivery →
 *                 Delivered (order state follows via the delivery-strategy-
 *                 router subscriber). Manual "Sync" fallback on the order card.
 * • Config      — pickup (store) details are the Adloggs calculator's
 *                 arguments on the shipping method (one method per store);
 *                 credentials come from env vars.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    providers: [
        { provide: ADLOGGS_PLUGIN_OPTIONS, useFactory: () => AdloggsPlugin.options },
        AdloggsService,
        AdloggsFulfillmentService,
        AdloggsFulfillmentSubscriber,
    ],
    controllers: [AdloggsWebhookController],
    dashboard: './dashboard/index.tsx',
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [AdloggsAdminResolver],
    },
    configuration: config => {
        config.shippingOptions.shippingCalculators.push(adloggsCalculator);

        const label = (value: string) => [{ languageCode: LanguageCode.en, value }];

        // ── Fulfillment: Adloggs order data ──
        // Admin-API-readable (internal: false) so the order-page cards can read
        // them through the standard order query — no extra lookup API needed.
        // readonly keeps them out of mutation inputs; the plugin writes them
        // directly via the repository.
        const fulfillmentField = (name: string, value: string, type: 'string' | 'text' | 'int' = 'string') => ({
            name,
            type: type as any,
            nullable: true,
            public: false,
            readonly: true,
            label: label(value),
            // Hidden from the fulfillment panel in both the Angular Admin UI and the
            // React Dashboard (serverConfig.entityCustomFields drops ui.dashboard:false
            // fields for both); the "Adloggs Delivery" card renders them instead.
            ui: { dashboard: false },
        });
        config.customFields.Fulfillment = [
            ...(config.customFields.Fulfillment || []),
            fulfillmentField('adloggsOrderUuid', 'Adloggs Order UUID'),
            fulfillmentField('adloggsStatus', 'Adloggs Status', 'int'),
            fulfillmentField('adloggsTrackUrl', 'Adloggs Tracking URL', 'text'),
            fulfillmentField('adloggsRiderName', 'Adloggs Rider Name'),
            fulfillmentField('adloggsRiderPhone', 'Adloggs Rider Phone'),
            // From the status webhook's otps.delivery_otp; the customer reads
            // it out to the rider (shop API Order.deliveryPerson.deliveryOtp).
            fulfillmentField('adloggsDeliveryOtp', 'Adloggs Delivery OTP'),
            fulfillmentField('adloggsFee', 'Adloggs Delivery Fee (₹)'),
            fulfillmentField('adloggsError', 'Adloggs Error', 'text'),
        ];

        return config;
    },
})
export class AdloggsPlugin {
    static options: PluginInitOptions;

    static init(options: PluginInitOptions): Type<AdloggsPlugin> {
        this.options = options;
        return AdloggsPlugin;
    }

    static UiExtensions: AdminUiExtension = {
        id: 'adloggs-ui',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}
