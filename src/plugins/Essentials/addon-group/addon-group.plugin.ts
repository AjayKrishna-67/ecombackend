import { LanguageCode, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { AddonGroupAdminResolver } from './api/addon-group-admin.resolver';
import { AddonGroupShopResolver, OrderAddonResolver, OrderLineAddonResolver } from './api/addon-group-shop.resolver';
import { AddonGroup } from './entities/addon-group.entity';
import { AddonItem } from './entities/addon-item.entity';
import { AddonGroupService } from './services/addon-group.service';
import { AddonGroupDataLoader } from './api/addon-group.dataloader';
import { AddonPriceCalculationStrategy } from './strategies/addon-price-calculation.strategy';
import { addonGroupPermission } from './permissions';
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [AddonGroupService, AddonGroupDataLoader],
    configuration: (config) => {
        config.authOptions.customPermissions.push(addonGroupPermission);
        // Bake addon prices into the order line's unit price so they scale
        // automatically when the line quantity changes.
        config.orderOptions.orderItemPriceCalculationStrategy = new AddonPriceCalculationStrategy();
        // ProductVariant -> AddonGroup[] (many-to-many, like facets)
        config.customFields.ProductVariant.push({
            name: 'addonGroups',
            type: 'relation',
            entity: AddonGroup,
            list: true,
            eager: false,
            public: true,
            label: [{ languageCode: LanguageCode.en, value: 'Addon Groups' }],
            description: [{ languageCode: LanguageCode.en, value: 'Addon groups assigned to this product variant' }],
            ui: { tab: 'Addon Groups', component: 'addon-group-relation-input' },
        } as any);
        // OrderLine custom field: JSON snapshot of addon selections.
        // Hidden from admin/shop GraphQL via `internal: true`; the storefront still gets
        // a parsed view through the OrderLineAddonResolver `addonSelections` field resolver.
        config.customFields.OrderLine.push({
            name: 'addonSelections',
            type: 'text',
            nullable: true,
            internal: true,
            label: [{ languageCode: LanguageCode.en, value: 'Addon Selections' }],
            description: [{ languageCode: LanguageCode.en, value: 'JSON array of addon selections chosen by the customer' }],
        });
        return config;
    },
    compatibility: '^3.1.0',
    dashboard: './dashboard/index.tsx',
    entities: [AddonGroup, AddonItem],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [AddonGroupAdminResolver, OrderLineAddonResolver, OrderAddonResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [AddonGroupShopResolver, OrderLineAddonResolver, OrderAddonResolver],
    },
})
export class AddonGroupPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'addon-group',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'addon-group', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
    };
}
