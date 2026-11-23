import { PluginCommonModule, Type, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { CustomOfferAdminResolver } from './api/custom-offer-admin.resolver';
import { CustomOfferShopResolver } from './api/custom-offer-shop.resolver';
import { OFFER_PLUGIN_OPTIONS } from './constants';
import { CustomOffer } from './entities/custom-offer.entity';
import { CustomOfferService } from './services/custom-offer.service';
import { PluginInitOptions } from './types';
import { offerPermission } from './permissions';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [{ provide: OFFER_PLUGIN_OPTIONS, useFactory: () => OfferPlugin.options }, CustomOfferService],
    configuration: config => {
        config.authOptions.customPermissions.push(offerPermission);
        return config;
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
    entities: [CustomOffer],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [CustomOfferAdminResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [CustomOfferShopResolver],
    },
})
export class OfferPlugin {
    static options: PluginInitOptions;

    static init(options: PluginInitOptions): Type<OfferPlugin> {
        this.options = options;
        return OfferPlugin;
    }

    static UiExtensions: AdminUiExtension = {
        id: 'cms-offer',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'offer', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
    };
}
