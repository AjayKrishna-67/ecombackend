import { LanguageCode, PluginCommonModule, VendurePlugin } from '@vendure/core';

import { adminApiExtensions } from './api/api-extensions';
import {
    DamageRequestLineEntityResolver,
    GoodsTransferAdminResolver,
    GoodsTransferEntityResolver,
    GoodsTransferLineEntityResolver,
} from './api/goods-transfer-admin.resolver';
import { allGoodsTransferPermissions } from './permissions';
import { ProductStockService } from '../product-stock/services/product-stock.service';
import { DamageService } from './services/damage.service';
import { DocumentSequenceService } from './services/document-sequence.service';
import { GoodsTransferService } from './services/goods-transfer.service';
import { TransferAuditService } from './services/transfer-audit.service';
import { TransferChannelService } from './services/transfer-channel.service';
import { PushSenderService } from './services/push-sender.service';
import { TransferNotificationService } from './services/transfer-notification.service';
import { TransferPdfService } from './services/transfer-pdf.service';
import { TransferReportService } from './services/transfer-report.service';
import { TransferStockService } from './services/transfer-stock.service';
import { ExpiryNotificationService } from './services/expiry-notification.service';
import { DamageRequest } from './entities/damage-request.entity';
import { DamageRequestLine } from './entities/damage-request-line.entity';
import { GoodsTransfer } from './entities/goods-transfer.entity';
import { GoodsTransferLine } from './entities/goods-transfer-line.entity';
import { TransferAuditLog } from './entities/transfer-audit-log.entity';
import { TransferDocumentSequence } from './entities/transfer-document-sequence.entity';
import { TransferNotification } from './entities/transfer-notification.entity';

/**
 * GoodsTransferPlugin — Goods Transfer & Damage Management System.
 *
 * Single source of truth: BRS v1.0 + TDS v1.0 (D:\Vendure Reports) +
 * clarifications doc 13 (Q1/Q2/Q3/Q4 confirmed decisions).
 *
 * Boundaries (BR-17): never touches Product Master data, pricing, orders,
 * sales, or other plugins. Existing-data writes (Steps 5+) go only through
 * core StockLevelService / ProductStockService.
 *
 * Q1 (confirmed): destination = user-selected Ship-To from THEIR assigned
 * channels (validated server-side) — the earlier TransferRoute config table
 * was removed in favour of this rule.
 *
 * Q4 (confirmed): registers ONE additive custom field —
 * ProductVariant.expiryDays (optional int) — filled by the Admin Team; used
 * read-only by the "Expire Soon" dashboard (Step 7). Indicator only.
 *
 * Step 3 scope (current): CRUD + lists + audit trail + first admin APIs.
 * Confirm/dispatch/approve/damage/notifications/reports arrive in Steps 4–7.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [
        GoodsTransfer,
        GoodsTransferLine,
        DamageRequest,
        DamageRequestLine,
        TransferNotification,
        TransferDocumentSequence,
        TransferAuditLog,
    ],
    providers: [
        TransferChannelService,
        DocumentSequenceService,
        TransferAuditService,
        GoodsTransferService,
        TransferPdfService,
        PushSenderService,
        TransferNotificationService,
        TransferStockService,
        DamageService,
        TransferReportService,
        ExpiryNotificationService,
        // Re-provided (stateless) so pool writes reuse the production pool logic —
        // sanctioned LocationStockPlugin pattern (avoids re-registering the global
        // stock-location strategy that ProductStockPlugin owns).
        ProductStockService,
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [
            GoodsTransferAdminResolver,
            GoodsTransferEntityResolver,
            GoodsTransferLineEntityResolver,
            DamageRequestLineEntityResolver,
        ],
    },
    configuration: config => {
        config.authOptions.customPermissions.push(...allGoodsTransferPermissions);
        // Q4 (confirmed): variant-level shelf-life in DAYS — additive, optional,
        // zero impact on existing behavior. Admin Team fills the values.
        config.customFields.ProductVariant.push({
            name: 'expiryDays',
            type: 'int',
            nullable: true,
            min: 0,
            public: false,
            label: [{ languageCode: LanguageCode.en, value: 'Expiry days (shelf life)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value:
                        'Shelf life in days. Used by Goods Transfer "Expire Soon" dashboard ' +
                        '(indicator only — never blocks stock or sales).',
                },
            ],
        });

        /**
         * Where to send this administrator's push notifications.
         *
         * A field rather than an endpoint of its own. The browser generates the
         * address when someone allows notifications, and it has to reach the server
         * somehow; core's updateActiveAdministrator already means "the signed-in
         * admin updates their own record", which is exactly this sentence. Adding a
         * mutation would restate it.
         *
         * Holds the browser's PushSubscription as JSON, or empty when notifications
         * are off. Not public: it belongs to one admin on one device and says
         * nothing to anyone else.
         */
        config.customFields.Administrator.push({
            name: 'gtPushSubscription',
            type: 'text',
            nullable: true,
            public: false,
            label: [{ languageCode: LanguageCode.en, value: 'Goods Transfer push subscription' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value:
                        'Set by the Goods Transfer app when this admin allows notifications. ' +
                        'Cleared automatically when the browser stops accepting them.',
                },
            ],
        });
        return config;
    },
    compatibility: '^3.6.3',
})
export class GoodsTransferPlugin {}
