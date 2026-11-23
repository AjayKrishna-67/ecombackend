import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import { TagsPlugin } from '../tags/tags.plugin';
import { adminApiExtensions } from './api/api-extensions';
import { ProductCsvResolver } from './api/product-csv.resolver';
import { ProductCsvService } from './services/product-csv.service';

/**
 * Product CSV tooling for the product list, in both the React Dashboard
 * (`dashboard`) and the classic Angular admin UI (`UiExtensions`).
 *
 * Backend (shared by both frontends):
 *  - exportProducts          (ReadCatalog)   — download current catalog as CSV
 *  - createProductsFromCsv   (CreateCatalog) — delegates to core's Importer
 *  - updateProductsFromCsv   (UpdateCatalog) — variant-grain upsert matched by SKU
 *
 * Create still rides on core's import engine (re-gated to CreateCatalog instead
 * of core's SuperAdmin); only update is custom.
 */
@VendurePlugin({
    imports: [PluginCommonModule, TagsPlugin],
    providers: [ProductCsvService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [ProductCsvResolver],
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
})
export class ProductImportPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'product-import-ui',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}
