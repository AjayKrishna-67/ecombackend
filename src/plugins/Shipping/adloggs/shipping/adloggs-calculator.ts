import { Injector, LanguageCode, Logger, ShippingCalculator } from '@vendure/core';

import { loggerCtx } from '../constants';
import { AdloggsService } from '../services/adloggs.service';
import { IST_UTC_OFFSET_MINUTES, pickupConfigFromArgs } from '../services/adloggs-mapper';

let adloggsService: AdloggsService;

/**
 * When an availability call fails (their dev gateway has been observed hanging
 * for 30s+), skip further live calls for a cooldown so every checkout render
 * doesn't stall by the request timeout. During the cooldown the method simply
 * drops out of eligibleShippingMethods.
 */
const FAILURE_COOLDOWN_MS = 60_000;
let lastFailureAt = 0;

const label = (value: string) => [{ languageCode: LanguageCode.en, value }];

/**
 * Live Adloggs rate at checkout: quotes the real delivery fee from the
 * availability API. The pickup (store) details are the calculator's own
 * `pickupConfig` argument — pinned on a map in the shipping-method form, one
 * method per store — and the delivery point is the customer's map pin
 * (Address custom fields latitude/longitude). The fulfillment flow reads the
 * same argument back from the order's shipping line when creating the order.
 *
 * Returning `undefined` excludes the method from eligibleShippingMethods —
 * done whenever Adloggs is unserviceable, unconfigured, or unreachable.
 */
export const adloggsCalculator = new ShippingCalculator({
    code: 'adloggs-calculator',
    description: [{ languageCode: LanguageCode.en, value: 'Adloggs live rates (distance-based)' }],
    args: {
        // One JSON arg written by the map-picker component (dashboard + Angular):
        // { name, phone, address, lat, long, pincode, city, state }.
        // required:false on purpose — Vendure defaults args to required:true and a
        // required-but-empty arg keeps the whole shipping-method form invalid
        // (Create/Update never enables); completeness is validated server-side by
        // pickupConfigFromArgs, which names the missing fields.
        pickupConfig: {
            type: 'string',
            defaultValue: '',
            required: false,
            label: label('Pickup Store'),
            ui: { component: 'adloggs-pickup-config-input' },
        },
    },

    init: (injector: Injector) => {
        adloggsService = injector.get(AdloggsService);
    },

    calculate: async (ctx, order, args) => {
        try {
            if (!adloggsService?.isConfigured) {
                return undefined;
            }
            const { config: pickup, missing } = pickupConfigFromArgs(args);
            if (!pickup) {
                Logger.warn(
                    `Adloggs shipping method is missing calculator arguments: ${missing.join(', ')}`,
                    loggerCtx,
                );
                return undefined;
            }

            const shippingAddress = order.shippingAddress;
            if (!shippingAddress?.postalCode) {
                return undefined; // no address yet
            }

            if (Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
                return undefined;
            }

            // Customer's map pin, or a pincode-level approximation for addresses
            // without one (admin draft orders) so the method is still selectable.
            const delivery = await adloggsService.resolveDeliveryPoint(shippingAddress);
            if (!delivery) {
                Logger.info(`Adloggs not quotable for order ${order.code}: address has no pin and pincode could not be geocoded`, loggerCtx);
                return undefined;
            }

            const result = await adloggsService.checkAvailability({
                partner_order_id: order.code,
                pickup_lat: pickup.lat,
                pickup_long: pickup.long,
                pickup_pincode: pickup.pincode,
                delivery_lat: delivery.lat,
                delivery_long: delivery.long,
                delivery_pincode: shippingAddress.postalCode,
                utc_offset: IST_UTC_OFFSET_MINUTES,
                payment_type: 'Online',
            });

            if (!result.status || !result.data?.service_available || result.data.estimated_price == null) {
                if (result.code === 0) {
                    // Transport failure/timeout — not a business "unserviceable".
                    lastFailureAt = Date.now();
                }
                Logger.info(
                    `Adloggs not quotable for order ${order.code}: ${result.data?.code || result.message}`,
                    loggerCtx,
                );
                return undefined;
            }

            return {
                price: Math.round(result.data.estimated_price * 100), // ₹ → paise
                priceIncludesTax: ctx.channel.pricesIncludeTax,
                taxRate: 0,
                metadata: {
                    provider: 'adloggs',
                    etaMinutes: result.data.to_pickup?.eta_min,
                    distanceKm: result.data.distance,
                    // true when quoted from the pincode centre, not an exact pin
                    approximate: delivery.approximate,
                },
            };
        } catch (error: any) {
            lastFailureAt = Date.now();
            Logger.error(`Adloggs rate calculation failed: ${error.message}`, loggerCtx);
            return undefined;
        }
    },
});
