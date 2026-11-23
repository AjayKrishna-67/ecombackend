import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { DefaultJobQueuePlugin, DefaultSchedulerPlugin, DefaultSearchPlugin, VendureConfig } from '@vendure/core';
import { RedisCachePlugin } from '@vendure/core/dist/plugin/redis-cache-plugin/redis-cache-plugin';
import { BullMQJobQueuePlugin } from '@vendure/job-queue-plugin/package/bullmq';
import { EmailPlugin, defaultEmailHandlers } from '@vendure/email-plugin';
import { AdminUiPlugin } from '@vendure/admin-ui-plugin';
import * as path from 'path';
import { configureCustomS3AssetStorage } from './cdn-aware-s3-storage';
import { customAdminUi } from './compile-admin-ui';

import { CancelOrderPlugin } from './plugins/Essentials/cancel-order/cancel-order.plugin';
import { CollectionIsPrivatePlugin } from './plugins/collectionIsPrivate';
import { ChannelPlugin } from './plugins/channelPlugin';
import { ShippingMethodSmsTemplatePlugin } from './plugins/Essentials/shipping-method-sms-template/shipping-method-sms-template.plugin';
import { OrderSmsNotificationPlugin } from './plugins/order-sms-notification.plugin';
import { OrderDeviceMediumPlugin } from './plugins/order-device-medium.plugin';
import { RazorpayPlugin } from './plugins/Payment/Razorpay/razorpay.plugin';
import { GoogleEmailNotificationPlugin } from './plugins/Authenticated/google-email-notification/google-email-notification.plugin';
import { PhoneOtpPlugin } from './plugins/Authenticated/otpmechanism/plugins/phone-otp.plugin';
import { BannerPlugin } from './plugins/Marketing/banner/banner.plugin';
import { OfferPlugin } from './plugins/Marketing/offer/offer.plugin';
import { LoyaltyPointsPlugin } from './plugins/Marketing/loyalty-points/loyalty-points.plugin';
import { FavoritesPlugin } from './plugins/Marketing/favorites/plugin';
import { FrequentlyOrderedPlugin } from './plugins/Marketing/frequently-ordered-plugin/frequently-ordered.plugin';
import { PriceUpdatePlugin } from './plugins/Essentials/price-update/price-update.plugin';
import { CartValidationPlugin } from './plugins/Essentials/cart-validation/cart-validation.plugin';
import { StockMonitoringPlugin } from './plugins/Stock/stock-monitoring/stock-monitoring.plugin';
import { AssetChannelSyncPlugin } from './plugins/Essentials/asset-channel-sync/asset-channel-sync.plugin';
import { StockLevelDeleterPlugin } from './plugins/Stock/stock-level-deleter/stock-level-deleter.plugin';
import { ProductStockPlugin } from './plugins/Stock/product-stock/product-stock.plugin';
import { LocationStockPlugin } from './plugins/Stock/location-stock/location-stock.plugin';
import { GoodsTransferPlugin } from './plugins/Stock/goods-transfer/goods-transfer.plugin';
import { EnabledShippingMethodsPlugin } from './plugins/Shipping/enabled-shipping-methods/enabled-shipping-methods.plugin';
import { WeightBasedShippingPlugin } from './plugins/Shipping/weight-based-shipping/weight-based-shipping.plugin';
import { TakeAwayPlugin } from './plugins/Shipping/take-away/take-away.plugin';
import { PostalCodePlugin } from './plugins/Essentials/postal-code/postal-code.plugin';
import { ChannelAvailabilityPlugin } from './plugins/Essentials/channel-availability/channel-availability.plugin';
import { ScheduledAvailabilityPlugin } from './plugins/Essentials/scheduled-availability/scheduled-availability.plugin';
import { CustomerChannelPlugin } from './plugins/Essentials/customer-channel/customer-channel.plugin';
import { PhoneNumberUniqueValidatorPlugin } from './plugins/Authenticated/phone-number-unique-validator/phone-number-unique-validator.plugin';
import { QuantityLimitPlugin } from './plugins/Essentials/quantity-limit/quantity-limit.plugin';
import { AccountDeletionRequestPlugin } from './plugins/Essentials/account-deletion-request/account-deletion-request.plugin';
import { InvoiceNumberPlugin } from './plugins/Essentials/invoice-number/invoice-number.plugin';
import { ProductImportPlugin } from './plugins/Essentials/product-import/product-import.plugin';
import { DeliveryStrategyRouterPlugin } from './plugins/own-delivery-partner/delivery-strategy-router/delivery-strategy-router.plugin';
import { ReferralRewardsPlugin } from './plugins/Essentials/referral-rewards/referral-rewards.plugin';
import { ReportsPlugin } from './plugins/Reports/reports.plugin';
import { BulkSyncPlugin } from './plugins/bulk-sync';
import { AddonGroupPlugin } from './plugins/Essentials/addon-group/addon-group.plugin';
import { OrderLocationMapPlugin } from './plugins/Essentials/order-location-map/order-location-map.plugin';
import { PromotionCodesPlugin } from './plugins/Marketing/promotion-codes/promotion-codes.plugin';
import { CustomerAnalyticsPlugin } from './plugins/Marketing/customer-analytics/customer-analytics.plugin';
import { AbandonedCartPlugin } from './plugins/Marketing/abandoned-cart';
import { TagsPlugin } from './plugins/Essentials/tags/tags.plugin';
import { PriceMatrixPlugin } from './plugins/Essentials/price-matrix/price-matrix.plugin';
import { AdminActivityLogPlugin } from './plugins/Essentials/admin-activity-log/admin-activity-log.plugin';
import { ShiprocketPlugin } from './plugins/Shipping/shiprocket/shiprocket.plugin';
import { AdloggsPlugin } from './plugins/Shipping/adloggs/adloggs.plugin';
import { DashboardUiPlugin } from './plugins/Essentials/dashboard-ui/dashboard-ui.plugin';
import { WhatsappPlugin } from './plugins/Essentials/whatsapp/whatsapp.plugin';

import { DashboardPlugin } from '@vendure/dashboard/plugin';
// import { SmartfloPlugin } from './plugins/Telephony/Smartflo/plugin/smartflo.plugin';

/**
 * Where uploaded assets are stored.
 *
 * Default is the live CDN bucket — unchanged, so nothing differs for anyone who does
 * not opt out. Set ASSET_STORAGE=local in your OWN .env to keep uploads on disk in
 * assetUploadDir instead: a developer creating test orders, transfer documents or
 * damage photos then never writes files into cdn.kaaikani.co.in.
 *
 * It is opt-IN on purpose. Keying this off APP_ENV would silently redirect the live
 * server's assets to local disk the moment someone deployed with the wrong APP_ENV.
 */
const USE_LOCAL_ASSET_STORAGE = process.env.ASSET_STORAGE === 'local';

export const plugins: VendureConfig['plugins'] = [
  AssetServerPlugin.init({
    route: 'assets',
    assetUploadDir: path.join(__dirname, 'assets'),
    ...(USE_LOCAL_ASSET_STORAGE
      ? {}
      : {
        storageStrategyFactory: configureCustomS3AssetStorage({
          bucket: 'cdn.kaaikani.co.in',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          },
          nativeS3Configuration: {
            region: 'ap-south-1',
          },
        }),
      }),
    assetUrlPrefix: (_ctx: any, _identifier: any) => {
      return '';
    },
    presets: [
      { name: 'tiny', width: 50, height: 50, mode: 'crop' },
      { name: 'thumb', width: 150, height: 150, mode: 'crop' },
      { name: 'small', width: 300, height: 300, mode: 'resize' },
      { name: 'medium', width: 500, height: 500, mode: 'resize' },
      { name: 'large', width: 800, height: 800, mode: 'resize' },
    ],
  }),
  // Distributed cache shared across server, worker, and any horizontally
  // scaled instances. Reuses the same Redis cluster as BullMQ but on a
  // dedicated DB index so cache and job queues never collide.
  // RedisCachePlugin.init({
  //   redisOptions: {
  //     host: process.env.REDIS_HOST,
  //     port: Number(process.env.REDIS_PORT),
  //     username: process.env.REDIS_USERNAME,
  //     password: process.env.REDIS_PASSWORD,
  //     db: Number(process.env.REDIS_CACHE_DB ?? 1),
  //     maxRetriesPerRequest: null,
  //   },
  // }),

    // DefaultJobQueuePlugin.init({ useDatabaseForBuffer: true }),
  RedisCachePlugin.init({
    namespace: 'vendure-cache',
    maxItemSizeInBytes: 128_000,
    redisOptions: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
    },
  }),
  BullMQJobQueuePlugin.init({
    connection: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
    },
    setRetries: (queueName, job) => {
      if (queueName === 'process-razorpay-webhook') {
        return 5;
      }
      if (queueName === 'send-email') {
        return 5;
      }
      return job.retries ?? 3;
    },
    setBackoff: (queueName, job) => {
      if (queueName === 'process-razorpay-webhook') {
        return {
          type: 'exponential',
          delay: 2000,
        };
      }
      if (queueName === 'send-email') {
        return {
          type: 'exponential',
          delay: 2000,
        };
      }
      return { type: 'exponential', delay: 10000 };
    },
    workerOptions: {
      removeOnComplete: {
        age: 60 * 60 * 24 * 2,
        count: 5000,
      },
      removeOnFail: {
        age: 60 * 60 * 24 * 2,
        count: 1000,
      },
      concurrency: 3,
    },
  }),

  DefaultSearchPlugin.init({ bufferUpdates: false, indexStockStatus: true }),
  DefaultSchedulerPlugin.init({}),

  // Schedules product/collection enable-disable at a future or recurring time.
  // Sits next to the scheduler because it registers a task into schedulerOptions.
  ScheduledAvailabilityPlugin,

  EmailPlugin.init({
    handlers: [
      ...defaultEmailHandlers.filter(handler => {
        const excludeTypes = ['email-verification', 'account-registration', 'order-confirmation'];
        return !excludeTypes.includes(handler.type);
      }),
    ],
    templatePath: path.join(__dirname, "../static/email/templates"),
    transport: {
      type: 'smtp',
      host: process.env.SMTP_HOST || 'email-smtp.ap-south-1.amazonaws.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USERNAME || '',
        pass: process.env.SMTP_PASSWORD || '',
      },
    },
    globalTemplateVars: {
      fromAddress: process.env.EMAIL_FROM || '"South Mithai" <noreply@southmithai.com>',
      shopUrl: process.env.SHOP_URL || 'https://southmithai.com',
    },
  }),
  

  AdminUiPlugin.init({
    port: 3002,
    app: customAdminUi({ recompile: false, devMode: false }),
    route: 'admin',
    adminUiConfig: {
    brand: 'AVS Ecom-HUB',  // <-- replaces {brand} on login page
    hideVendureBranding: false,
    hideVersion: false,
  },
  }),

   DashboardPlugin.init({ 
            // The route should correspond to the `base` setting
            // in the vite.config.mts file
            route: 'dashboard', 
            // This appDir should correspond to the `build.outDir`
            // setting in the vite.config.mts file
            appDir: './dist/dashboard', 
        }), 

  // Authentication
  GoogleEmailNotificationPlugin,
  CustomerChannelPlugin,
  PhoneOtpPlugin,
  PhoneNumberUniqueValidatorPlugin,

  // Core / Essentials
  ChannelPlugin,
  CancelOrderPlugin,
  CollectionIsPrivatePlugin,
  ShippingMethodSmsTemplatePlugin,
  OrderSmsNotificationPlugin,
  OrderDeviceMediumPlugin,
  PriceUpdatePlugin,
  CartValidationPlugin,
  PostalCodePlugin,
  ChannelAvailabilityPlugin,
  QuantityLimitPlugin,
  AccountDeletionRequestPlugin,
  InvoiceNumberPlugin,
  ProductImportPlugin,
  TagsPlugin,
  PriceMatrixPlugin,
  AdminActivityLogPlugin,
  DashboardUiPlugin,
  // Replies to incoming WhatsApp messages with an "Order now" card.
  // Meta webhook URL: https://<host>/whatsapp/webhook
  WhatsappPlugin.init({
    phoneNumberId: process.env.WA_PHONE_ID ?? '',
    accessToken: process.env.WA_TOKEN ?? '',
    verifyToken: process.env.WA_VERIFY_TOKEN ?? '',
    appSecret: process.env.WA_APP_SECRET ?? '',
    storeUrl: process.env.STORE_URL ?? '',
    brand: process.env.WA_BRAND ?? '',
    // Comma-separated tester phones (e.g. 918525876381); while set, only they get replies.
    testNumbers: (process.env.WA_TEST_NUMBERS ?? '')
      .split(',')
      .map(n => n.replace(/\D/g, ''))
      .filter(Boolean),
    // Sends for a brand with sendVia 'msg91' (Kaaikani); same account as OrderWhatsappService.
    msg91: {
      authKey: process.env.MSG91_AUTH_KEY ?? '',
      integratedNumber: process.env.MSG91_HELLO_NUMBER ?? '',
    },
  }),

  // Payment
  RazorpayPlugin,

  // Marketing-UI
  BannerPlugin,
  OfferPlugin,
  LoyaltyPointsPlugin,
  FavoritesPlugin,

  FrequentlyOrderedPlugin,
    ReferralRewardsPlugin,
  PromotionCodesPlugin,
  CustomerAnalyticsPlugin,
  AbandonedCartPlugin,


  // Shipping & Fulfillment
  EnabledShippingMethodsPlugin,
  WeightBasedShippingPlugin,
  TakeAwayPlugin,
  DeliveryStrategyRouterPlugin,
  // Single plugin for all Shiprocket integrations (Quick/domestic + International)
  ShiprocketPlugin.init({
    email: process.env.SHIPROCKET_EMAIL,
    password: process.env.SHIPROCKET_PASSWORD,
  }),
  // Adloggs hyperlocal rider delivery (see src/plugins/Shipping/adloggs/ADLOGGS_DOCUMENTATION.md)
  AdloggsPlugin.init({
    apiHost: process.env.ADLOGGS_HOST || 'https://dev.adloggs.com',
    apiKey: process.env.ADLOGGS_API_KEY || '',
    webhookToken: process.env.ADLOGGS_WEBHOOK_TOKEN || '',
  }),

 

  // Stock - UI
  StockMonitoringPlugin,
  StockLevelDeleterPlugin,
  ProductStockPlugin,
  LocationStockPlugin,
  GoodsTransferPlugin,

  // Addon groups (product variant addons + price calculation strategy)
  AddonGroupPlugin,
  OrderLocationMapPlugin,

  // Reports
  ReportsPlugin,
  BulkSyncPlugin,

  // Keeps Asset channel assignments in step with the Products/Variants/
  // Collections that display them. Without it the Dashboard silently deletes
  // images on any save made from a channel the Asset is not assigned to.
  AssetChannelSyncPlugin,
];
