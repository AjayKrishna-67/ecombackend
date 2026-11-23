import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

import { OrderLocationBackfillService } from './services/order-location-backfill.service';

/**
 * Shows the customer's pinned delivery location (Address custom fields
 * `latitude`/`longitude`, set by the storefront map picker) as a map with
 * a pin on the order detail page — in both the Angular admin UI and the
 * React dashboard. The custom fields themselves are defined in
 * vendure-config-custom-fields.ts.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [OrderLocationBackfillService],
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
})
export class OrderLocationMapPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'order-location-map',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}
