// compile-admin-ui.ts
import { compileUiExtensions, setBranding } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

import { ProductImportPlugin } from './plugins/Essentials/product-import/product-import.plugin';
// Angular admin-ui extension imports — commented out during React Dashboard migration.
// Re-enable per-plugin as needed, or delete once fully migrated to @vendure/dashboard.
import { RazorpayPlugin } from './plugins/Payment/Razorpay/razorpay.plugin';
import { BannerPlugin } from './plugins/Marketing/banner/banner.plugin';
import { OfferPlugin } from './plugins/Marketing/offer/offer.plugin';
import { LoyaltyPointsPlugin } from './plugins/Marketing/loyalty-points/loyalty-points.plugin';
import { StockMonitoringPlugin } from './plugins/Stock/stock-monitoring/stock-monitoring.plugin';
import { StockLevelDeleterPlugin } from './plugins/Stock/stock-level-deleter/stock-level-deleter.plugin';
import { ProductStockPlugin } from './plugins/Stock/product-stock/product-stock.plugin';
import { PostalCodePlugin } from './plugins/Essentials/postal-code/postal-code.plugin';
import { EnabledShippingMethodsPlugin } from './plugins/Shipping/enabled-shipping-methods/enabled-shipping-methods.plugin';
import { AccountDeletionRequestPlugin } from './plugins/Essentials/account-deletion-request/account-deletion-request.plugin';
import { DeliveryStrategyRouterPlugin } from './plugins/own-delivery-partner/delivery-strategy-router/delivery-strategy-router.plugin';
import { ReferralRewardsPlugin } from './plugins/Essentials/referral-rewards/referral-rewards.plugin';
import { CustomerAnalyticsPlugin } from './plugins/Marketing/customer-analytics/customer-analytics.plugin';
import { AddonGroupPlugin } from './plugins/Essentials/addon-group/addon-group.plugin';
import { ChannelAvailabilityPlugin } from './plugins/Essentials/channel-availability/channel-availability.plugin';
import { OrderLocationMapPlugin } from './plugins/Essentials/order-location-map/order-location-map.plugin';
import { CancelOrderPlugin } from './plugins/Essentials/cancel-order/cancel-order.plugin';
import { ShiprocketPlugin } from './plugins/Shipping/shiprocket/shiprocket.plugin';
import { AdloggsPlugin } from './plugins/Shipping/adloggs/adloggs.plugin';
import { TakeAwayPlugin } from './plugins/Shipping/take-away/take-away.plugin';
import { PromotionCodesPlugin } from './plugins/Marketing/promotion-codes/promotion-codes.plugin';
import { ScheduledAvailabilityPlugin } from './plugins/Essentials/scheduled-availability/scheduled-availability.plugin';


if (require.main === module) {
  customAdminUi({ recompile: true, devMode: false })
    .compile?.()
    .then(() => process.exit(0));
}

export function customAdminUi(options: {
  recompile: boolean;
  devMode: boolean;
}) {
  const compiledAppPath = path.join(__dirname, '../admin-ui');

  if (options.recompile) {
    return compileUiExtensions({
      outputPath: compiledAppPath,
      extensions: [
        ProductImportPlugin.UiExtensions,

        // Angular UI extensions disabled during React Dashboard migration:
        BannerPlugin.UiExtensions,
        OfferPlugin.UiExtensions,
        LoyaltyPointsPlugin.UiExtensions,
        StockMonitoringPlugin.ui,
        RazorpayPlugin.UiExtensions,
        StockLevelDeleterPlugin.UiExtensions,
        ProductStockPlugin.UiExtensions,
        PostalCodePlugin.UiExtensions,
        EnabledShippingMethodsPlugin.UiExtensions,
        ReferralRewardsPlugin.UiExtensions,
        AccountDeletionRequestPlugin.ui,
        DeliveryStrategyRouterPlugin.UiExtensions,
        AddonGroupPlugin.UiExtensions,
        ChannelAvailabilityPlugin.UiExtensions,
        // CustomerAnalyticsPlugin.UiExtensions,

        OrderLocationMapPlugin.UiExtensions,
        CancelOrderPlugin.UiExtensions,
        ShiprocketPlugin.UiExtensions,
        AdloggsPlugin.UiExtensions,
        TakeAwayPlugin.UiExtensions,
        PromotionCodesPlugin.UiExtensions,
        ScheduledAvailabilityPlugin.UiExtensions,

        {
          // 1. Load the translations
          translations: {
            en: path.join(__dirname, 'ui-extensions/translations/en.json'),
          },
          // 2. Load the global styles
          globalStyles: path.join(__dirname, 'ui-extensions/theme.scss'),
        },
        setBranding({
          smallLogoPath: path.join(__dirname, '/assets/KaaiKani.png'),
          largeLogoPath: path.join(__dirname, '/assets/KaaiKani.png'),
          faviconPath: path.join(__dirname, '/assets/KaaiKani.png'),
        }),
      ],
      devMode: options.devMode,
    });
  } else {
    return {
      path: path.join(compiledAppPath, 'dist/browser'),
    };
  }
}
