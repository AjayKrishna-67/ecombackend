import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

import { takeAwayAdminApiExtensions, TakeAwayAdminResolver } from './api/take-away-admin.resolver';
import { TakeAwayShopResolver } from './api/take-away-shop.resolver';
import { takeAwayOrderCustomFields, takeAwayShippingMethodCustomFields } from './take-away.custom-fields';
import { TakeAwayOrderSnapshotService } from './take-away-order-snapshot.service';
import { takeAwayPickupTimeProcess } from './take-away-pickup-time.process';
import { takeAwaySelectedCondition } from './take-away-promotion-condition';
import { takeAwayShippingCalculator } from './take-away-shipping-calculator';

/**
 * Take Away (store pickup) support:
 *
 * - `take-away-calculator`: free shipping calculator for the pickup method.
 * - `take_away_shipping_selected` promotion condition: lets the admin create a
 *   10% promotion (with or without a coupon code) that applies only while the
 *   Take Away method is selected.
 * - Store location custom fields on ShippingMethod (public, so the storefront
 *   can pin the store on a map from `eligibleShippingMethods`).
 * - On order placed, the store location is snapshotted onto the order's custom
 *   fields so order history shows the pickup point as it was at purchase time.
 * - Pickup time: the store's daily pickup hours on the method (`pickupSlot`,
 *   edited with dropdowns in the Store Location card). The customer picks a
 *   time within them (order `pickupTime`, via the core `setOrderCustomFields`
 *   mutation, validated against the hours, required at checkout by
 *   `takeAwayPickupTimeProcess`, cleared when switching to a method whose
 *   hours do not contain it). The hours are copied onto the order at
 *   placement with the rest of the snapshot.
 *
 * Setup (Admin UI): create a ShippingMethod using this calculator, tick
 * "Is Take Away (Store Pickup)" on its Store Location tab and pin the store on
 * the map, then create a Promotion with the "Take Away shipping method is
 * selected" condition and a 10% order discount. No method-code convention —
 * the takeAway custom field is the marker.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.0.0',
    providers: [TakeAwayOrderSnapshotService],
    adminApiExtensions: {
        schema: takeAwayAdminApiExtensions,
        resolvers: [TakeAwayAdminResolver],
    },
    shopApiExtensions: {
        // No schema additions — overrides the built-in setOrderShippingMethod
        // resolver to auto-apply/remove the take-away coupon.
        resolvers: [TakeAwayShopResolver],
    },
    dashboard: './dashboard/index.tsx',
    configuration: config => {
        config.shippingOptions.shippingCalculators.push(takeAwayShippingCalculator);
        config.promotionOptions.promotionConditions.push(takeAwaySelectedCondition);
        config.orderOptions.process.push(takeAwayPickupTimeProcess);
        config.customFields.ShippingMethod = [
            ...(config.customFields.ShippingMethod ?? []),
            ...takeAwayShippingMethodCustomFields,
        ];
        config.customFields.Order = [...(config.customFields.Order ?? []), ...takeAwayOrderCustomFields];
        return config;
    },
})
export class TakeAwayPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'take-away-ui',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}
