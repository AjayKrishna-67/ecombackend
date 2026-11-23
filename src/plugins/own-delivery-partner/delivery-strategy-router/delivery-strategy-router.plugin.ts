import { PluginCommonModule, VendurePlugin, LanguageCode } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';

// Fulfillment Handler & Processes
import { deliveryFulfillmentHandler } from './fulfillment/delivery-fulfillment.handler';
import { deliveryFulfillmentProcess } from './fulfillment/delivery-fulfillment.process';
import { deliveryOrderProcess } from './fulfillment/delivery-order.process';

// API Extensions
import { adminApiExtensions, shopApiExtensions } from './api/api-extensions';
import { FleetGateway } from './api/fleet.gateway';

// Resolvers
import { CustomFulfillmentAdminResolver } from './api/resolver/admin/delivery-partner-admin.resolver';
import { DeliveryTrackingResolver } from './api/resolver/admin/delivery-tracking.resolver';
import { DeliveryTrackingShopResolver } from './api/resolver/shop/delivery-tracking-shop.resolver';
import { OrderDeliveryPersonShopResolver } from './api/resolver/shop/order-delivery-person-shop.resolver';

// Services
import { DeliveryPartnerService } from './services/delivery-partner.service';
import { DeliveryFulfillmentService } from './services/delivery-fulfillment.service';
import { DeliveryReportService } from './services/delivery-report.service';
import { DeliveryFulfillmentStateSubscriber } from './services/delivery-fulfillment-state.subscriber';
import { DeliveryQrCodeService } from './services/delivery-qr-code.service';
import { DeliveryPaymentLinkService } from './services/delivery-payment-link.service';
import { DeliveryTrackingService } from './services/delivery-tracking.service';
import { DeliveryRouteService } from './services/delivery-route.service';

// Entities
import { DeliveryRide } from './entities/delivery-ride.entity';
import { DriverStatus } from './entities/driver-status.entity';

// Permissions
import { customFulfillmentPermission, outForDeliveryPermission, deliveredPermission, viewDeliveryReportsPermission } from './permissions';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [DeliveryRide, DriverStatus],
    providers: [
        DeliveryPartnerService,
        DeliveryFulfillmentService,
        DeliveryReportService,
        DeliveryFulfillmentStateSubscriber,
        DeliveryQrCodeService,
        DeliveryPaymentLinkService,
        DeliveryTrackingService,
        DeliveryRouteService,
        FleetGateway,
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [CustomFulfillmentAdminResolver, DeliveryTrackingResolver],
    },
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [DeliveryTrackingShopResolver, OrderDeliveryPersonShopResolver],
    },
    compatibility: '^3.6.3',
    dashboard: './dashboard/index.tsx',
    configuration: config => {
        // Register custom permissions
        config.authOptions.customPermissions.push(
            customFulfillmentPermission,
            outForDeliveryPermission,
            deliveredPermission,
            viewDeliveryReportsPermission,
        );

        // Register the delivery fulfillment handler
        config.shippingOptions.fulfillmentHandlers.push(deliveryFulfillmentHandler);

        // Register custom fulfillment process with OutforDelivery state
        config.shippingOptions.process.push(deliveryFulfillmentProcess);

        // Register custom order process with OutforDelivery state
        config.orderOptions.process.push(deliveryOrderProcess);

        // Add custom fields to Fulfillment entity (all internal — displayed via custom UI component)
        config.customFields.Fulfillment = [
            ...(config.customFields.Fulfillment || []),
            {
                name: 'fulfillmentType',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Fulfillment Type' }],
            },
            {
                name: 'deliveryPersonId',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Delivery Person ID' }],
            },
            {
                name: 'deliveryPersonName',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Delivery Person' }],
            },
            {
                name: 'deliveryPersonPhone',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Phone Number' }],
            },
            {
                name: 'paymentCollectionMethod',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Payment Collection Method' }],
            },
            {
                name: 'collectedAmount',
                type: 'int',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Collected Amount' }],
            },
            {
                name: 'collectionNote',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Collection Note' }],
            },
            {
                name: 'deliveredAt',
                type: 'datetime',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Delivered At' }],
            },
            // ─── QR Code Payment Fields ───
            {
                name: 'qrCodeId',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Razorpay QR Code ID' }],
            },
            {
                name: 'qrCodeImageUrl',
                type: 'text',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'QR Code Image URL' }],
            },
            {
                name: 'qrCodeStatus',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'QR Code Status' }],
            },
            {
                name: 'qrCashAmount',
                type: 'int',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'QR Cash Portion' }],
            },
            {
                name: 'qrAmount',
                type: 'int',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'QR Payment Amount' }],
            },
            {
                name: 'qrRazorpayOrderId',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'QR Razorpay Order ID' }],
            },
            // ─── Payment Link Fields ───
            {
                name: 'paymentLinkId',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Razorpay Payment Link ID' }],
            },
            {
                name: 'paymentLinkShortUrl',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Payment Link Short URL' }],
            },
            {
                name: 'paymentLinkStatus',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Payment Link Status' }],
            },
            {
                name: 'paymentLinkPhone',
                type: 'string',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Payment Link Phone' }],
            },
            {
                name: 'paymentLinkAmount',
                type: 'int',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Payment Link Amount' }],
            },
        ];

        return config;
    },
})
export class DeliveryStrategyRouterPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'delivery-partner-ui',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}
