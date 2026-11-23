import { Permission, PluginCommonModule, SettingsStoreScopes, VendurePlugin, LanguageCode } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { shopApiExtensions } from './api/api-extensions';
import { CancelOrderResolver } from './api/cancel-order.resolver';
import { cancellationRequestProcess } from '../../../customOrderProcess/cancellation-process';

// Import the Service and Subscriber
import { Msg91Service } from './services/msg91.service';
import { CancellationSubscriber } from './subscribers/cancellation.subscriber';

@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    providers: [
      Msg91Service,
      CancellationSubscriber,
    ],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [CancelOrderResolver],
    },
    dashboard: './dashboard/index.tsx',
    configuration: config => {

        // Add Custom Process
        config.orderOptions.process.push(cancellationRequestProcess);

        // Cancellation-alert recipients, edited on the Global Settings page instead of
        // being hardcoded in Msg91Service. Two layers: a channel-scoped override keyed off
        // the admin's active channel on write and the order's channel on send, plus a
        // global-scoped shared default for channels that have none. Permissions mirror that
        // page's own gates, so no new custom permission needs assigning to a role — they
        // also gate the built-in get/setSettingsStoreValue operations.
        config.settingsStoreFields = config.settingsStoreFields ?? {};
        // Namespace + name must together equal the keys in ./constants.ts.
        const alertPermissions = {
            read: Permission.ReadSettings,
            write: Permission.UpdateGlobalSettings,
        };
        config.settingsStoreFields.cancelOrder = [
            // Per-channel override. Empty = "not set", which falls through to defaultAlertConfig.
            { name: 'alertConfig', scope: SettingsStoreScopes.channel, requiresPermission: alertPermissions },
            // Shared fallback used by any channel without its own list.
            {
                name: 'defaultAlertConfig',
                scope: SettingsStoreScopes.global,
                requiresPermission: alertPermissions,
            },
        ];

        // Add Custom Fields
        config.customFields.Order.push({
            name: 'cancellationReason',
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Cancellation Reason' }],
            defaultValue: '',
            public: false,
        });

        config.customFields.Order.push({
            name: 'otherInstructions',
            type: 'string',
            defaultValue: '',
            label: [{ languageCode: LanguageCode.en, value: 'Other Instructions' }],
        });

        return config;
    },
})
export class CancelOrderPlugin {
    // Classic Angular admin-ui block, injected into the Global Settings detail page.
    // The React Dashboard equivalent is registered via the `dashboard` entry above;
    // both run in parallel and read/write the same SettingsStore key.
    static UiExtensions: AdminUiExtension = {
        id: 'cancel-order',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}