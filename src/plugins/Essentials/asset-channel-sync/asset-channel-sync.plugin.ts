import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    CollectionEvent,
    EventBus,
    PluginCommonModule,
    ProductChannelEvent,
    ProductEvent,
    ProductVariantChannelEvent,
    ProductVariantEvent,
    VendurePlugin,
} from '@vendure/core';

import { AssetChannelSyncService } from './services/asset-channel-sync.service';

/**
 * Subscribes to every event that can put an Asset out of step with the channels
 * of the entity displaying it, and reconciles the affected entities.
 *
 * Two distinct drift paths, both covered:
 *
 *  1. The entity gains a channel      -> ProductChannelEvent / ProductVariantChannelEvent
 *  2. The entity gains an asset       -> ProductEvent / ProductVariantEvent / CollectionEvent
 *
 * Only 'assigned' channel events matter. A 'removed' one cannot create drift --
 * the asset simply stays visible in a channel that no longer shows the product,
 * which is harmless. Un-assigning it would be the destructive move, so this
 * never does.
 *
 * 'deleted' entity events are skipped for the same reason: there is nothing left
 * to keep in step, and the asset assignments are not ours to withdraw.
 */
@Injectable()
export class AssetChannelSyncListener implements OnApplicationBootstrap {
    constructor(
        private readonly eventBus: EventBus,
        private readonly syncService: AssetChannelSyncService,
    ) {}

    onApplicationBootstrap(): void {
        this.eventBus.ofType(ProductChannelEvent).subscribe(event => {
            if (event.type !== 'assigned') {
                return;
            }
            // Variants are assigned alongside the product but raise their own
            // event, so the product id alone is enough here.
            void this.syncService.syncTargets({ productIds: [event.product.id] });
        });

        this.eventBus.ofType(ProductVariantChannelEvent).subscribe(event => {
            if (event.type !== 'assigned') {
                return;
            }
            void this.syncService.syncTargets({ variantIds: [event.productVariant.id] });
        });

        this.eventBus.ofType(ProductEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return;
            }
            void this.syncService.syncTargets({ productIds: [event.entity.id] });
        });

        this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return;
            }
            // `entity` is an ARRAY on this event, unlike every other entity
            // event -- a bulk variant save raises one event for all of them.
            void this.syncService.syncTargets({ variantIds: event.entity.map(v => v.id) });
        });

        this.eventBus.ofType(CollectionEvent).subscribe(event => {
            if (event.type === 'deleted') {
                return;
            }
            void this.syncService.syncTargets({ collectionIds: [event.entity.id] });
        });
    }
}

/**
 * Prevents the Dashboard from silently destroying product images.
 *
 * See services/asset-channel-sync.service.ts for the full mechanism. In short:
 * `assets` is channel-filtered but `featuredAssetId` is not, so on a channel
 * that an Asset was never assigned to, the detail page reads an empty asset list
 * and submits `assetIds: []` -- which Vendure treats as "delete them all".
 *
 * Historical damage was repaired by migration
 * 1785995000000-backfill-asset-channels (3048 links, 1416 at-risk variants).
 * This plugin stops it recurring.
 *
 * AUDIT -- should always return zero rows:
 *
 *   SELECT c.code, COUNT(DISTINCT v.id)
 *   FROM product_variant v
 *   JOIN product_variant_channels_channel vc ON vc.productVariantId = v.id
 *   JOIN channel c ON c.id = vc.channelId
 *   JOIN product_variant_asset pva ON pva.productVariantId = v.id
 *   LEFT JOIN asset_channels_channel ac
 *     ON ac.assetId = pva.assetId AND ac.channelId = c.id
 *   WHERE v.deletedAt IS NULL AND ac.assetId IS NULL
 *   GROUP BY c.code;
 *
 * If it ever does not, `AssetChannelSyncService.syncAll()` repairs everything.
 *
 * Upstream: PR #4916 ("Send only changed fields on detail page updates") removes
 * this whole bug class by not resending untouched fields, but is unmerged as of
 * 2026-08-06. Keep this plugin until that ships and this project is on it.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [AssetChannelSyncService, AssetChannelSyncListener],
    compatibility: '^3.6.3',
})
export class AssetChannelSyncPlugin {}
