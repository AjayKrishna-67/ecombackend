import { LanguageCode, ShippingCalculator } from '@vendure/core';

/**
 * Store pickup costs the customer nothing — always returns a price of 0.
 *
 * The `storeLocation` arg holds no data (the store location lives in the
 * ShippingMethod custom fields): it exists so the admin UIs render the full
 * Store Location picker INSIDE the Calculator card via its custom component,
 * which writes through to the custom fields.
 */
export const takeAwayShippingCalculator = new ShippingCalculator({
    code: 'take-away-calculator',
    description: [{ languageCode: LanguageCode.en, value: 'Take Away (store pickup) — free' }],
    args: {
        storeLocation: {
            type: 'string',
            defaultValue: '',
            // CRITICAL: Vendure defaults config args to required:true. A
            // required empty display-only arg makes the whole shipping-method
            // form permanently invalid — Create/Update button never enables.
            required: false,
            label: [{ languageCode: LanguageCode.en, value: 'Store Location' }],
            ui: { component: 'take-away-store-location-arg' },
        },
    },
    calculate: (ctx, order) => {
        return {
            price: 0,
            priceIncludesTax: ctx.channel.pricesIncludeTax,
            taxRate: 0,
            metadata: { takeAway: true },
        };
    },
});
