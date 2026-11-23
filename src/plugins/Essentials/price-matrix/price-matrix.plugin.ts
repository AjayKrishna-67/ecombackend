import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { TagsPlugin } from '../tags/tags.plugin';
import { adminApiExtensions } from './api/api-extensions';
import { PriceMatrixAdminResolver } from './api/price-matrix-admin.resolver';
import { PriceMatrixService } from './services/price-matrix.service';
import { PriceChangeLog } from './entities/price-change-log.entity';

/**
 * Tag-based multi-channel price editor backend.
 *
 * Provides `variantPriceMatrix` (read) and `setVariantChannelPrices` (atomic
 * write) for the PWA bulk price tool. Imports TagsPlugin to reuse TagService
 * for tag -> product resolution. Writes go through ProductVariantService and
 * re-publish ProductVariantEvent so the existing PriceUpdatePlugin syncs open
 * carts. Registers the PriceChangeLog audit entity (see the generated
 * PriceChangeLog migration) to record each variant×channel price change.
 */
@VendurePlugin({
    imports: [PluginCommonModule, TagsPlugin],
    entities: [PriceChangeLog],
    providers: [PriceMatrixService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [PriceMatrixAdminResolver],
    },
    compatibility: '^3.6.3',
})
export class PriceMatrixPlugin {}
