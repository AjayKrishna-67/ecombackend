import { LanguageCode, ShippingCalculator } from '@vendure/core';

import { ShiprocketService } from '../services/shiprocket.service';
import {
    baseRateInr,
    computeFinalMinorUnits,
    eddDays,
    findCourierByName,
    selectBox,
    slabMarkupInr,
    tariffTotalInr,
} from './pricing';

let service: ShiprocketService;

/**
 * Shiprocket International rate calculator. Bind one Vendure ShippingMethod per courier via the
 * `courierName` arg (matched case-insensitively against `courier_name` in the Shiprocket response).
 * The customer is charged the courier's base rate + the slab markup + static charge, converted to
 * the order currency. Any import tariff Shiprocket returns is recorded in metadata but NOT charged.
 *
 * Returns `undefined` (method hidden) when the courier isn't serviceable OR returns no price; in
 * that case the markup / static charge are not applied either.
 */
export const shiprocketCalculator = new ShippingCalculator({
    code: 'shiprocket-international',
    description: [{ languageCode: LanguageCode.en, value: 'Shiprocket International Rate' }],
    args: {
        courierName: {
            type: 'string',
            label: [{ languageCode: LanguageCode.en, value: 'Shiprocket courier name' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Exact courier name from Shiprocket, e.g. "SRX Economy", "Aramex International", "India Post Air Parcel". Binds this method to one courier (matched case-insensitively).',
                },
            ],
        },
        grams: {
            type: 'int',
            defaultValue: 500,
            label: [{ languageCode: LanguageCode.en, value: 'Markup slab size (grams)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'For every this-many grams of cart weight (rounded up), add the per-slab amount.',
                },
            ],
        },
        gramsPerAmount: {
            type: 'float',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Amount per slab (₹)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Rupees added per weight slab. Set 0 to disable the per-gram markup.',
                },
            ],
        },
        staticCharge: {
            type: 'float',
            defaultValue: 0,
            label: [{ languageCode: LanguageCode.en, value: 'Static charge (₹)' }],
            description: [
                {
                    languageCode: LanguageCode.en,
                    value: 'Flat handling fee added to every quote for this courier.',
                },
            ],
        },
    },
    init(injector) {
        service = injector.get(ShiprocketService);
    },
    calculate: async (ctx, order, args) => {
        const country = order.shippingAddress?.countryCode;
        if (!country) {
            return undefined;
        }
        const config = await service.getConfig(ctx);
        if (!config.pickupPincode) {
            return undefined;
        }
        const { weightGrams, hsnCodes } = await service.getShipmentData(ctx, order);
        if (weightGrams <= 0) {
            return undefined;
        }
        const box = selectBox(config.boxBrackets, weightGrams);
        if (!box) {
            return undefined;
        }
        const resp = await service.getServiceability({
            pickupPincode: config.pickupPincode,
            deliveryCountry: country,
            weightKg: Number((weightGrams / 1000).toFixed(3)),
            length: box.length,
            breadth: box.breadth,
            height: box.height,
            hsnCodes,
            cod: 0,
        });
        const couriers = resp?.data?.available_courier_companies ?? [];
        const courier = findCourierByName(couriers, args.courierName);
        if (!courier) {
            // Chosen courier not serviceable for this destination/weight → method hidden.
            return undefined;
        }

        const baseInr = baseRateInr(courier);
        if (baseInr <= 0) {
            // Courier returned no price → don't apply markup/static charge; hide the method.
            return undefined;
        }
        const fxRate = config.fxRate > 0 ? config.fxRate : 1;
        const edd = eddDays(courier);
        const price = computeFinalMinorUnits({
            baseInr,
            weightGrams,
            grams: args.grams,
            gramsPerAmount: args.gramsPerAmount,
            staticCharge: args.staticCharge,
            fxRate,
        });

        return {
            price,
            priceIncludesTax: ctx.channel.pricesIncludeTax,
            taxRate: 0,
            metadata: {
                courierName: courier.courier_name,
                etd: courier.etd,
                estimatedDeliveryDays: courier.estimated_delivery_days,
                // Estimated delivery window in days, e.g. { from: 10, to: 12 }.
                eddFrom: edd.from,
                eddTo: edd.to,
                weightGrams,
                box,
                // Import duty rate from Shiprocket — informational only, NOT added to the price.
                importTariff: tariffTotalInr(courier),
                breakdown: {
                    baseInr,
                    slabMarkupInr: slabMarkupInr(weightGrams, args.grams, args.gramsPerAmount),
                    staticChargeInr: args.staticCharge,
                    fxRate,
                },
            },
        };
    },
});
