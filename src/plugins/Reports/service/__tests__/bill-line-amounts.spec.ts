import { describe, expect, it } from 'vitest';

import { billLineAmounts } from '../bill-line-amounts';

describe('billLineAmounts', () => {
    it('a line with no coupon keeps its full price', () => {
        expect(billLineAmounts({ linePriceWithTax: 7000, discountedLinePriceWithTax: 7000 })).toEqual({
            discountedTotal: 7000,
            isFree: false,
        });
    });

    it('a coupon free product is free (charged nothing, but has a price)', () => {
        expect(billLineAmounts({ linePriceWithTax: 3500, discountedLinePriceWithTax: 0 })).toEqual({
            discountedTotal: 0,
            isFree: true,
        });
    });

    it('a product discount lowers the line but does not make it free', () => {
        expect(billLineAmounts({ linePriceWithTax: 10000, discountedLinePriceWithTax: 9000 })).toEqual({
            discountedTotal: 9000,
            isFree: false,
        });
    });

    it('buy X get Y freeing one of two units is a partial discount, not free', () => {
        expect(billLineAmounts({ linePriceWithTax: 14000, discountedLinePriceWithTax: 7000 })).toEqual({
            discountedTotal: 7000,
            isFree: false,
        });
    });

    it('a zero-priced line is not called free', () => {
        expect(billLineAmounts({ linePriceWithTax: 0, discountedLinePriceWithTax: 0 }).isFree).toBe(false);
    });

    it('never goes below zero or above the full price', () => {
        expect(billLineAmounts({ linePriceWithTax: 3500, discountedLinePriceWithTax: -1 }).discountedTotal).toBe(0);
        expect(billLineAmounts({ linePriceWithTax: 3500, discountedLinePriceWithTax: 4000 }).discountedTotal).toBe(3500);
    });
});
