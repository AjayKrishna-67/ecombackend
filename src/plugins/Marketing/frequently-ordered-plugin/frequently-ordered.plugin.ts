import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { shopApiExtensions, adminApiExtensions } from './api/api-extensions';
import { FrequentlyOrderedShopResolver } from './api/frequently-ordered-shop.resolver';
import { FrequentlyOrderedAdminResolver } from './api/frequently-ordered-admin.resolver';
import { FrequentlyOrderedItem } from './entities/frequently-ordered-item.entity';
import './type';
import { FrequentlyOrderedService } from './service/frequently-ordered.service';
import { FrequentlyOrderedUIModule } from './ui/frequently-ordered-ui.module';
import * as path from 'path';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import { FrequentlyOrderedSubscriber } from './api/frequently-ordered.subscriber';

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [FrequentlyOrderedItem],
  providers: [FrequentlyOrderedService, FrequentlyOrderedSubscriber],
  shopApiExtensions: {
    schema: shopApiExtensions,
    resolvers: [FrequentlyOrderedShopResolver],
  },
  adminApiExtensions: { 
    schema: adminApiExtensions, 
    resolvers: [FrequentlyOrderedAdminResolver],
  },
  compatibility: '^3.6.3', 
})
export class FrequentlyOrderedPlugin {
  static ui: AdminUiExtension = {
    extensionPath: path.join(__dirname, 'ui'),
    ngModules: [
      {
        type: 'shared' as const,
        ngModuleFileName: 'frequently-ordered-ui.module.ts',
        ngModuleName: 'FrequentlyOrderedUIModule',
      }
    ],
  };
}