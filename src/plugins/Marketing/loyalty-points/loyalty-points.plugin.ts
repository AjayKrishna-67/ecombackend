import * as path from 'path';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import { LanguageCode, PluginCommonModule, Type, VendurePlugin, Injector } from '@vendure/core';
import { LOYALTY_POINTS_PLUGIN_OPTIONS } from './constants';
import { PluginInitOptions } from './types';
import { LoyaltyPointsTransaction } from './entities/loyalty-points-transaction.entity';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { LoyaltyPointsOrderProcess } from './config/loyalty-points-order-process';
import { LoyaltyPointsAdminResolver } from './api/loyalty-points-admin.resolver';
import { CustomerEntityResolver } from './api/customer-entity.resolver';
import { LoyaltyPointsShopResolver } from './api/loyalty-points-shop.resolver';
import { LoyaltyPointsService } from './service/loyalty-points.service';
import { LoyaltyPointsConfig } from './entities/loyalty-points-config.entity';
import { loyaltyPointsPermission } from './permissions';

@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [
    {
      provide: LOYALTY_POINTS_PLUGIN_OPTIONS,
      useFactory: () => LoyaltyPointsPlugin.options,
    },
    LoyaltyPointsService,
    
  ],
  exports: [LoyaltyPointsService],
  configuration: (config) => {
    // Register custom permission
    config.authOptions.customPermissions.push(loyaltyPointsPermission);
    
    config.customFields = {
      ...config.customFields,
      Customer: [
        ...(config.customFields?.Customer || []),
        {
          name: 'loyaltyPointsAvailable',
          type: 'int',
          defaultValue: 0,
          public: true,
          readonly: false,
          label: [{ languageCode: LanguageCode.en, value: 'Total loyalty points available to use' }],
          ui: { component: 'customer-points-link' },
        },
      ],
      Order: [
        ...(config.customFields?.Order || []),
        {
          name: 'loyaltyPointsUsed',
          type: 'int',
          defaultValue: 0,
          public: true,
          readonly: false, 
          label: [{ languageCode: LanguageCode.en, value: 'Loyalty points used on this order' }],
        },
        {
          name: 'loyaltyPointsEarned',
          type: 'int',
          defaultValue: 0,
          public: true,
        readonly: false, 
          label: [{ languageCode: LanguageCode.en, value: 'Loyalty points earned on this order' }],
        },
      ],
    };

    config.orderOptions.process.push(new LoyaltyPointsOrderProcess());
    
 
    return config;
  },
  adminApiExtensions: {
    schema: adminApiExtensions,
    resolvers: [LoyaltyPointsAdminResolver, CustomerEntityResolver],
  },
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: [LoyaltyPointsShopResolver, CustomerEntityResolver],
  },
  compatibility: '^3.6.3',
  dashboard: './dashboard/index.tsx',
  entities: [LoyaltyPointsTransaction, LoyaltyPointsConfig],
})
export class LoyaltyPointsPlugin {
  static options: PluginInitOptions;

  static init(options: PluginInitOptions): Type<LoyaltyPointsPlugin> {
    this.options = options;
    return LoyaltyPointsPlugin;
  }

  static UiExtensions: AdminUiExtension = {
    id: 'loyalty-points-ui',
    extensionPath: path.join(__dirname, 'ui'),
    routes: [{ route: 'loyalty-points', filePath: 'routes.ts' }],
    providers: ['providers.ts'],
  };
}