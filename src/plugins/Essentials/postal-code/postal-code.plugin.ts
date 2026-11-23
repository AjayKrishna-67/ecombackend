import { LanguageCode, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { PostalCodeAdminResolver } from './api/postal-code-admin.resolver';
import { PostalCodeShopResolver } from './api/postal-code-shop.resolver';
import { PostalCode } from './entities/postal-code.entity';
import { PostalCodeArea } from './entities/postal-code-area.entity';
import { PostalCodeService } from './services/postal-code.service';
import { postalCodePermission } from './permissions';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [PostalCodeService],
    configuration: (config) => {
        config.authOptions.customPermissions.push(postalCodePermission);
        config.customFields.Address = config.customFields.Address || [];
        config.customFields.Address.push({
            name: 'area',
            type: 'string',
            nullable: true,
            public: true,
            label: [{ languageCode: LanguageCode.en, value: '' }],
            ui: { component: 'pincode-area-input' },
        });
        return config;
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
    entities: [PostalCode, PostalCodeArea],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [PostalCodeAdminResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [PostalCodeShopResolver],
    },
})
export class PostalCodePlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'postal-code',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'postal-code', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
        ngModules: [
            {
                type: 'shared' as const,
                ngModuleFileName: 'postal-code-ui-extension.module.ts',
                ngModuleName: 'PostalCodeUiExtensionModule',
            },
        ],
    };
}
