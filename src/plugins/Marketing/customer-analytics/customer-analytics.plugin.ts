import { PluginCommonModule, SettingsStoreScopes, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { adminApiExtensions } from './api/api-extensions';
import { CustomerAnalyticsAdminResolver } from './api/customer-analytics-admin.resolver';
import { CustomerSegmentService } from './services/customer-segment.service';
import { customerAnalyticsPermission, updateCustomerAnalyticsPermission } from './permissions';

/**
 * Customer Analytics — recency (RFM) segmentation over the order table.
 *
 * - Live aggregation via {@link CustomerSegmentService} (no entity / migration / worker).
 * - Channel-scoped thresholds in the SettingsStore (activeWithinDays / atRiskUntilDays).
 * - Read gated by {@link customerAnalyticsPermission}; save-as-group by UpdateCustomerGroup.
 * - Dashboard page registered via the React `dashboard` entry (see ./dashboard).
 * - Classic Angular admin page registered via {@link UiExtensions} (see ./ui); both run
 *   in parallel and call the same admin API.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [CustomerSegmentService],
    configuration: config => {
        config.authOptions.customPermissions.push(
            customerAnalyticsPermission,
            updateCustomerAnalyticsPermission,
        );
        config.settingsStoreFields = config.settingsStoreFields ?? {};
        // requiresPermission gates the built-in setSettingsStoreValue mutation too, so the
        // generic write path cannot bypass setRecencyThresholds' validation + Update gate.
        const requiresPermission = {
            read: customerAnalyticsPermission.Permission,
            write: updateCustomerAnalyticsPermission.Permission,
        };
        config.settingsStoreFields.customerAnalytics = [
            { name: 'activeWithinDays', scope: SettingsStoreScopes.channel, requiresPermission },
            { name: 'atRiskUntilDays', scope: SettingsStoreScopes.channel, requiresPermission },
        ];
        return config;
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [CustomerAnalyticsAdminResolver],
    },
})
export class CustomerAnalyticsPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'customer-analytics',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'customer-analytics', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
    };
}
