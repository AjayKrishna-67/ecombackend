import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { ShippingMethodFilterResolver } from './api/shipping-method-filter.resolver';
import { shopApiExtensions } from './api/api-extensions';

/**
 * EnabledShippingMethodsPlugin
 *
 * This plugin provides a custom query to get enabled shipping methods.
 * It allows admins to enable/disable shipping methods using the custom `enabled` field,
 * and provides a Shop API query `eligibleShippingMethodsEnabled` that only shows enabled methods.
 *
 * Usage in GraphQL:
 * query {
 *   eligibleShippingMethodsEnabled {
 *     id
 *     name
 *     description
 *     price
 *     priceWithTax
 *   }
 * }
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [ShippingMethodFilterResolver],
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
})
export class EnabledShippingMethodsPlugin {
    static UiExtensions: AdminUiExtension = {
        extensionPath: path.join(__dirname, 'ui'),
        ngModules: [
            {
                type: 'lazy',
                route: 'shipping-method',
                ngModuleFileName: 'shipping-method-ui.extensions.ts',
                ngModuleName: 'ShippingMethodUiModule',
            },
        ],
    };
}
