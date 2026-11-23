import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { ChannelAvailabilityService } from './services/channel-availability.service';
import { BrandStorefrontService } from './services/brand-storefront.service';
import { BrandSwitcherService } from './services/brand-switcher.service';
import { ChannelAvailabilityResolver } from './api/channel-availability.resolver';
import { BrandStorefrontAdminResolver } from './api/brand-storefront-admin.resolver';
import { shopApiExtensions, adminApiExtensions } from './api/api-extensions';
import { BrandStorefront } from './entities/brand-storefront.entity';
import { BrandSwitcherEntry } from './entities/brand-switcher-entry.entity';
import { brandStorefrontPermission } from './permissions';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [BrandStorefront, BrandSwitcherEntry],
    providers: [ChannelAvailabilityService, BrandStorefrontService, BrandSwitcherService],
    exports: [ChannelAvailabilityService, BrandStorefrontService, BrandSwitcherService],
    configuration: config => {
        config.authOptions.customPermissions.push(brandStorefrontPermission);
        return config;
    },
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [BrandStorefrontAdminResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [ChannelAvailabilityResolver],
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.3',
})
export class ChannelAvailabilityPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'brand-storefront',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'brand-storefronts', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
    };
}
