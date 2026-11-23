import {
    Injector,
    LanguageCode,
    Logger,
    ShippingCalculator,
    RequestContext,
    Order,
    TransactionalConnection,
} from '@vendure/core';
import { resolveVariantMeasures } from '../../../Stock/shared/resolve-variant-measure';
import { ShipRocket } from '../services/ship-rocket';
import { loggerCtx } from '../constants';
import { QuickRate, QuickRateParams } from '../types';
import { resolveDeliveryCoords } from './resolve-delivery-coords';

let shipRocketService: ShipRocket;
let connection: TransactionalConnection;

export const shiprocketQuickCalculator = new ShippingCalculator({
    code: 'shiprocket-quick-calculator',
    description: [{ languageCode: LanguageCode.en, value: 'Shiprocket Quick live rates (distance-based)' }],
    args: {
        priorityPincodes: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Priority Pincodes (Comma-separated)' }],
            description: [{ languageCode: LanguageCode.en, value: 'Comma-separated list of pincodes to prioritize when selecting pickup addresses (e.g., "641038,625018,620009"). Leave empty to use automatic pincode matching.' }],
            required: false,
        },
    },

    init: (injector: Injector) => {
        shipRocketService = injector.get(ShipRocket);
        connection = injector.get(TransactionalConnection);
    },

    calculate: async (ctx, order, args) => {
        if (!shipRocketService) {
            Logger.error('ShipRocket service not initialized for Quick ShippingCalculator', loggerCtx);
            return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0 };
        }

        try {
            const shippingAddress = order.shippingAddress;
            if (!shippingAddress?.postalCode) {
                Logger.warn('No shipping address or postal code found', loggerCtx);
                return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0 };
            }

            // Map pin from the order's own address, falling back to the
            // customer's saved addresses — admin draft orders arrive without
            // custom fields, so the pin only exists on the saved address.
            const deliveryPoint = await resolveDeliveryCoords(ctx, order, connection, loggerCtx);

            if (!deliveryPoint) {
                Logger.warn(`Shipping address missing latitude/longitude for order ${order.code}`, loggerCtx);
                return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0, metadata: { error: 'Missing coordinates' } };
            }
            const { lat: deliveryLat, long: deliveryLong } = deliveryPoint;

            // Parse priority pincodes from args (comma-separated string)
            const priorityPincodes = args.priorityPincodes 
                ? args.priorityPincodes.split(',').map(p => p.trim()).filter(p => p.length > 0)
                : undefined;

            // Find nearest pickup address (pass pincode, city, and priority pincodes for priority matching)
            const nearestPickup = await shipRocketService.findNearestPickupAddress(
                deliveryLat, 
                deliveryLong,
                shippingAddress.postalCode, // Pass pincode for priority matching
                shippingAddress.city, // Pass city for priority matching
                priorityPincodes // Pass admin-configured priority pincodes
            );
            
            if (!nearestPickup) {
                Logger.warn('No active pickup address found', loggerCtx);
                return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0, metadata: { error: 'No pickup address' } };
            }

            const pickupLat = parseFloat(nearestPickup.lat);
            const pickupLong = parseFloat(nearestPickup.long);

            if (isNaN(pickupLat) || isNaN(pickupLong)) {
                Logger.warn(`Invalid pickup address coordinates: ${nearestPickup.lat}, ${nearestPickup.long}`, loggerCtx);
                return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0, metadata: { error: 'Invalid pickup coordinates' } };
            }

            // Calculate total weight from each variant's option, with the
            // historic 500 g default for anything unmeasured.
            const measures = await resolveVariantMeasures(
                ctx,
                connection,
                order.lines.map(l => l.productVariant).filter(Boolean),
            );
            const totalWeight = order.lines.reduce((weight, line) => {
                const productWeight =
                    measures.get(String(line.productVariant.id))?.grams || 500; // Default 500g
                return weight + (productWeight * line.quantity);
            }, 0);

            const weightInKg = Math.max(0.5, totalWeight / 1000); // Minimum 0.5kg

            // Prepare Quick rate params
            const rateParams: QuickRateParams = {
                pickup_postcode: parseInt(nearestPickup.pin_code),
                delivery_postcode: parseInt(shippingAddress.postalCode),
                cod: 0, // Quick orders don't support COD
                is_new_hyperlocal: 1,
                lat_from: pickupLat,
                long_from: pickupLong,
                lat_to: deliveryLat,
                long_to: deliveryLong,
            };

            const quickRates = await shipRocketService.getQuickShippingRates(rateParams);

            if (!quickRates || quickRates.length === 0) {
                Logger.warn(`No Quick shipping options found for order ${order.code}`, loggerCtx);
                return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0, metadata: { unavailable: true } };
            }

            // Get the first (and typically only) Quick rate
            const quickRate = quickRates[0];

            const finalPrice = quickRate.rates;

            Logger.info(`Quick shipping rate calculated: ${finalPrice} for order ${order.code}`, loggerCtx);

            return {
                price: Math.round(finalPrice * 100), // Convert to cents
                priceIncludesTax: ctx.channel.pricesIncludeTax,
                taxRate: 0,
                metadata: {
                    courierName: quickRate.courier_name,
                    etd: quickRate.etd,
                    etdHours: quickRate.etd_hours,
                    distance: quickRate.distance,
                    pickupLocation: nearestPickup.pickup_location,
                    pickupAddressId: nearestPickup.id,
                },
            };

        } catch (error: any) {
            Logger.error(`Shiprocket Quick shipping calculation failed: ${error.message}`, loggerCtx, error.stack);
            return { price: 0, priceIncludesTax: ctx.channel.pricesIncludeTax, taxRate: 0, metadata: { error: true } };
        }
    },
});





