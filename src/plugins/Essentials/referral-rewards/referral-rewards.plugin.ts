import * as path from 'path';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { Referral } from './entities/referral.entity';
import { ReferralChannelPoints } from './entities/referral-channel-points.entity';
import { ReferralRewardsService } from './service/referral-rewards.service';
import { ReferralRewardsAdminResolver } from './api/resolver/admin/referral-rewards-admin.resolver';
import { ReferralRewardsShopResolver, ReferralFieldResolver } from './api/resolver/shop/referral-rewards-shop.resolver';
import { ReferralCustomerEntityResolver } from './api/resolver/customer-entity.resolver';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { referralRewardsPermission } from './permissions';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [ReferralRewardsService],
    exports: [ReferralRewardsService],
    configuration: (config) => {
        config.authOptions.customPermissions.push(referralRewardsPermission);
        return config;
    },
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [ReferralRewardsAdminResolver, ReferralFieldResolver, ReferralCustomerEntityResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [ReferralRewardsShopResolver, ReferralFieldResolver, ReferralCustomerEntityResolver],
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
    entities: [Referral, ReferralChannelPoints],
})
export class ReferralRewardsPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'referral-rewards-ui',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'referral-rewards', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
        ngModules: [
            {
                type: 'shared' as const,
                ngModuleFileName: 'referral-ui-extension.module.ts',
                ngModuleName: 'ReferralUiExtensionModule',
            },
        ],
    };
}
