import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { TagsPlugin } from '../../Essentials/tags/tags.plugin';
import { ProductStockService } from '../product-stock/services/product-stock.service';
import { adminApiExtensions } from './api/api-extensions';
import { LocationStockAdminResolver } from './api/resolver/admin/location-stock.resolver';
import { StockChangeLog } from './entities/stock-change-log.entity';
import { LocationStockService } from './services/location-stock.service';

/**
 * Location-first stock editor backend.
 *
 * Two tabs over two stock kinds, split by one classifier (has a weight pool or
 * not). Variant-wise writes go through StockLevelService.updateStockOnHandForLocation;
 * weight-pool writes reuse ProductStockService.setProductStock. Imports TagsPlugin
 * to reuse TagService for tag -> product scoping. Registers the StockChangeLog
 * audit entity (see the generated StockChangeLog migration).
 *
 * ProductStockService is re-provided here (stateless, only needs
 * TransactionalConnection) rather than importing ProductStockPlugin, which would
 * re-register its stock-location strategy and dashboard block.
 */
@VendurePlugin({
    imports: [PluginCommonModule, TagsPlugin],
    entities: [StockChangeLog],
    providers: [LocationStockService, ProductStockService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [LocationStockAdminResolver],
    },
    // No admin-UI dashboard: this tool lives in the PWA (delivery-dashboard),
    // which calls the admin API resolvers above. Backend only here.
    compatibility: '^3.6.3',
})
export class LocationStockPlugin {}
