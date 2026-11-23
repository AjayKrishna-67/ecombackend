// src/plugins/Shipping/shiprocket/shiprocket.plugin.ts
import gql from 'graphql-tag';
import {
    LanguageCode,
    PluginCommonModule,
    SettingsStoreScopes,
    Type,
    VendurePlugin,
} from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

// --- Shared / Quick (domestic hyperlocal) ---
import { SHIPROCKET_PLUGIN_OPTIONS } from './constants';
import { PluginInitOptions } from './types';
import { ShipRocket } from './services/ship-rocket';
import { ShipRocketAdminResolver } from './api/ship-rocket-admin.resolver';
import {
    adminApiExtensions as quickAdminApiExtensions,
    shopApiExtensions as quickShopApiExtensions,
} from './api/api-extensions';
import { shiprocketQuickCalculator } from './shipping/shiprocket-quick-calculator';
import { ShipRocketShopResolver } from './api/ship-rocket-shop.resolver';
import { ShiprocketQuickFulfillmentService } from './fulfillment/shiprocket-quick-fulfillment.service';
import { ShiprocketQuickFulfillmentSubscriber } from './fulfillment/shiprocket-quick-fulfillment.subscriber';

// --- International ---
import {
    adminApiExtensions as intlAdminApiExtensions,
    shopApiExtensions as intlShopApiExtensions,
} from './international/api/api-extensions';
import { ShiprocketAdminResolver } from './international/api/shiprocket-admin.resolver';
import { ShiprocketShopResolver } from './international/api/shiprocket-shop.resolver';
import { shiprocketCalculator } from './international/config/shiprocket-calculator';
import { shiprocketEligibilityChecker } from './international/config/shiprocket-eligibility-checker';
import { shiprocketFulfillmentHandler } from './international/config/shiprocket-fulfillment-handler';
import {
    readShiprocketSettingsPermission,
    updateShiprocketSettingsPermission,
} from './international/permissions';
import { ShiprocketOrderService } from './international/services/shiprocket-order.service';
import { ShiprocketService } from './international/services/shiprocket.service';

/**
 * ShiprocketPlugin — single plugin for ALL Shiprocket integrations.
 *
 * Domestic / Quick (hyperlocal):
 *   • Quoting     — `shiprocket-quick-calculator` (distance-based, uses Address
 *                   latitude/longitude custom fields).
 *   • Fulfillment — event subscriber creates the Shiprocket Quick order
 *                   (`orders/create/adhoc`, shipping_method "HL") when a KaaiKani
 *                   fulfillment of type "shiprocket-quick" is created; auto-cancels
 *                   on order/fulfillment cancellation.
 *   • Admin UI    — "Shiprocket Quick" card on the order-detail page (Angular
 *                   admin-ui) with live data, refresh and Ship Now (AWB).
 *
 * International:
 *   • Quoting     — one ShippingMethod per courier (shared eligibility checker +
 *                   calculator, box brackets / FX from the SettingsStore config).
 *   • Fulfillment — FulfillmentHandler creates the Shiprocket order
 *                   (`international/orders/create/adhoc`) and stores ids/status on
 *                   the Fulfillment custom fields.
 *   • Tracking    — admin "sync" mutation (`orders/show`) + live shop/admin
 *                   tracking (`track/awb`), proxied so the token stays server-side.
 *   • Dashboard   — React dashboard settings page + order block
 *                   (`./international/dashboard/index.tsx`).
 *
 * Shared internals:
 *   • One auth-token layer — `ShiprocketService.getToken()` delegates to the
 *     shared `ShipRocket` service, so both integrations reuse a single cached
 *     login (SHIPROCKET_EMAIL/PASSWORD).
 *   • One set of Fulfillment custom fields (string columns) used by both:
 *     shiprocketOrderId, shiprocketChannelOrderId, shiprocketShipmentId,
 *     shiprocketStatus, shiprocketAwb, shiprocketCourierName, … plus the
 *     Quick-only `pickupLocation`.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    providers: [
        { provide: SHIPROCKET_PLUGIN_OPTIONS, useFactory: () => ShiprocketPlugin.options },
        // Shared IO / Quick
        ShipRocket,
        ShiprocketQuickFulfillmentService,
        ShiprocketQuickFulfillmentSubscriber,
        // International
        ShiprocketService,
        ShiprocketOrderService,
    ],
    dashboard: './dashboard/index.tsx',
    adminApiExtensions: {
        schema: gql`
            ${quickAdminApiExtensions}
            ${intlAdminApiExtensions}
        `,
        resolvers: [ShipRocketAdminResolver, ShiprocketAdminResolver],
    },
    shopApiExtensions: {
        schema: gql`
            ${quickShopApiExtensions}
            ${intlShopApiExtensions}
        `,
        resolvers: [ShipRocketShopResolver, ShiprocketShopResolver],
    },
    configuration: config => {
        // --- International: permissions + channel-scoped settings ---
        config.authOptions.customPermissions.push(
            readShiprocketSettingsPermission,
            updateShiprocketSettingsPermission,
        );
        const requiresPermission = {
            read: readShiprocketSettingsPermission.Permission,
            write: updateShiprocketSettingsPermission.Permission,
        };
        // One channel-scoped JSON blob holds the whole intl config (see ShiprocketConfig).
        config.settingsStoreFields = config.settingsStoreFields ?? {};
        config.settingsStoreFields.shiprocket = [
            { name: 'config', scope: SettingsStoreScopes.channel, requiresPermission },
        ];

        // --- Shipping calculators / checker / fulfillment handler ---
        config.shippingOptions.shippingCalculators.push(shiprocketQuickCalculator);
        config.shippingOptions.shippingEligibilityCheckers.push(shiprocketEligibilityChecker);
        config.shippingOptions.shippingCalculators.push(shiprocketCalculator);
        config.shippingOptions.fulfillmentHandlers.push(shiprocketFulfillmentHandler);

        // --- Fulfillment custom fields (shared by Quick + International) ---
        // One shipment = one fulfillment. All internal — surfaced via the
        // order-detail dashboard block / Quick order card, not the default field UI.
        const label = (value: string) => [{ languageCode: LanguageCode.en, value }];
        const strField = (name: string, value: string, type: 'string' | 'text' = 'string') => ({
            name,
            type: type as any,
            nullable: true,
            internal: true,
            label: label(value),
        });
        const intField = (name: string, value: string) => ({
            name,
            type: 'int' as any,
            nullable: true,
            internal: true,
            label: label(value),
        });
        config.customFields.Fulfillment = [
            ...(config.customFields.Fulfillment || []),
            strField('shiprocketOrderId', 'Shiprocket Order ID'),
            strField('shiprocketChannelOrderId', 'Shiprocket Channel Order ID'),
            strField('shiprocketShipmentId', 'Shiprocket Shipment ID'),
            strField('shiprocketStatus', 'Shiprocket Status'),
            strField('shiprocketAwb', 'AWB Code'),
            strField('shiprocketCourierName', 'Courier Name'),
            strField('shiprocketCourierId', 'Courier ID'),
            strField('shiprocketTrackUrl', 'Tracking URL', 'text'),
            strField('shiprocketInvoiceUrl', 'Invoice URL', 'text'),
            intField('shiprocketLength', 'Box Length (cm)'),
            intField('shiprocketBreadth', 'Box Breadth (cm)'),
            intField('shiprocketHeight', 'Box Height (cm)'),
            intField('shiprocketWeightGrams', 'Weight (g)'),
            {
                name: 'shiprocketLastSyncedAt',
                type: 'datetime' as any,
                nullable: true,
                internal: true,
                label: label('Last Synced At'),
            },
            // Quick-only: pickup location tag selected for the hyperlocal order.
            strField('pickupLocation', 'Pickup Location'),
        ];

        return config;
    },
})
export class ShiprocketPlugin {
    static options: PluginInitOptions;

    static init(options: PluginInitOptions): Type<ShiprocketPlugin> {
        this.options = options;
        return ShiprocketPlugin;
    }

    static UiExtensions: AdminUiExtension = {
        id: 'shiprocket-ui',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'shiprocket-international', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
    };
}
