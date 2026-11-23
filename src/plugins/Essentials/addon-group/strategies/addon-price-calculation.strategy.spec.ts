import { describe, expect, it } from 'vitest';
import { AddonPriceCalculationStrategy } from './addon-price-calculation.strategy';

const strategy = new AddonPriceCalculationStrategy();
const ctx: any = {};
const ADDONS = JSON.stringify([{ items: [{ unitPrice: 2000, quantity: 1 }] }]);

/** Variant now costs ₹45.00 at the channel; the order line was priced at ₹4.50 when the customer tapped Pay. */
const variant: any = { id: 572, listPrice: 4500, listPriceIncludesTax: true };

function orderIn(state: string, lines: any[] = [{ productVariantId: 572, listPrice: 450, listPriceIncludesTax: true, customFields: {} }]): any {
    return { state, lines };
}

describe('AddonPriceCalculationStrategy price lock', () => {
    it('keeps the line price of an order the customer is paying for (ArrangingPayment)', () => {
        const actual = strategy.calculateUnitPrice(ctx, variant, {}, orderIn('ArrangingPayment'), 1);
        expect(actual).toEqual({ price: 450, priceIncludesTax: true });
    });

    it('matches the line on variant AND addon selections', () => {
        const order = orderIn('ArrangingPayment', [
            { productVariantId: 572, listPrice: 450, listPriceIncludesTax: true, customFields: {} },
            { productVariantId: 572, listPrice: 2450, listPriceIncludesTax: true, customFields: { addonSelections: ADDONS } },
        ]);
        expect(strategy.calculateUnitPrice(ctx, variant, { addonSelections: ADDONS }, order, 1).price).toBe(2450);
        expect(strategy.calculateUnitPrice(ctx, variant, {}, order, 1).price).toBe(450);
    });

    it('prices a cart (AddingItems) at the current channel price, as before', () => {
        expect(strategy.calculateUnitPrice(ctx, variant, {}, orderIn('AddingItems'), 1).price).toBe(4500);
    });

    it('still adds addon prices on a cart, as before', () => {
        expect(strategy.calculateUnitPrice(ctx, variant, { addonSelections: ADDONS }, orderIn('AddingItems'), 1).price).toBe(6500);
    });

    it('falls back to the current price when no line matches (nothing to keep)', () => {
        const order = orderIn('ArrangingPayment', [{ productVariantId: 999, listPrice: 100, listPriceIncludesTax: true, customFields: {} }]);
        expect(strategy.calculateUnitPrice(ctx, variant, {}, order, 1).price).toBe(4500);
    });
});
