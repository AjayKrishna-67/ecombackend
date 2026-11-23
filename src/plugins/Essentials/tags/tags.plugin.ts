import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { adminApiExtensions } from './api/api-extensions';
import { TagAdminResolver } from './api/tag-admin.resolver';
import { ProductTag } from './entities/product-tag.entity';
import { ProductVariantTag } from './entities/product-variant-tag.entity';
import { CatalogTag } from './entities/tag.entity';
import { TagService } from './services/tag.service';

/**
 * Product & Variant Tags — free-form, internal, channel-scoped labels with
 * admin filtering.
 *
 * Backend is shared by both admin frontends. The React Dashboard (/dashboard)
 * UI is wired via `dashboard` below. The Angular admin-ui (/admin) chip
 * component is a separate follow-up (T5) and will register its own
 * AdminUiExtension when added.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [TagService],
    exports: [TagService],
    entities: [CatalogTag, ProductTag, ProductVariantTag],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [TagAdminResolver],
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
})
export class TagsPlugin {}
