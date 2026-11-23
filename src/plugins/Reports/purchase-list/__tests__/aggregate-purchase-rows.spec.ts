import { describe, expect, it } from 'vitest';

import { aggregatePurchaseRows, purchaseLabel } from '../aggregate-purchase-rows';
import { buildProductMaster, ProductMaster } from '../product-master';

/**
 * Fixtures mirror real rows from the 05-08-2026 purchase list, so a failure here
 * points at a line the team would actually notice on the printed sheet.
 */
const master: ProductMaster = buildProductMaster([
    { SKU: 'APL250', 'Tamil Name': 'ஆப்பிள் 250', 'Product Name': 'Apple 250gm', Weight: 0.25, 'Group Name': 'ஆப்பிள்', OrdNo: 40, Category: 'Fruits' },
    { SKU: 'APL500', 'Tamil Name': 'ஆப்பிள் 500', 'Product Name': 'Apple 500gm', Weight: 0.5, 'Group Name': 'ஆப்பிள்', OrdNo: 40, Category: 'Fruits' },
    { SKU: 'APL1K', 'Tamil Name': 'ஆப்பிள் 1', 'Product Name': 'Apple 1kg', Weight: 1, 'Group Name': 'ஆப்பிள்', OrdNo: 40, Category: 'Fruits' },
    { SKU: 'BEET', 'Tamil Name': 'பீட்ரூட்(ஊட்டி)', 'Product Name': 'Beetroot Ooty', Weight: 0.25, 'Group Name': 'பீட்ரூட்(ஊட்டி)', OrdNo: 10, Category: 'Vegetables' },
    // Quantity-priced: Weight is the pack count, not kilograms. 5 எண் bananas
    // legitimately print as 5.000 -- this is not a unit bug.
    { SKU: 'BAN5', 'Tamil Name': 'நாட்டு வாழைப்பழம் (5 எண் )', 'Product Name': 'Country Banana 5nos', Weight: 5, 'Group Name': 'நாட்டு வாழைப்பழம் (5 எண் )', OrdNo: 41, Category: 'Fruits' },
]);

describe('aggregatePurchaseRows', () => {
    // The reason Group Name exists: a buyer makes ONE apple decision, not three.
    it('rolls every pack size of a product into a single group row', () => {
        const rows = aggregatePurchaseRows(
            [
                { pCode: 'APL250', itemName: 'Apple 250gm', qty: 4 }, // 1.00
                { pCode: 'APL500', itemName: 'Apple 500gm', qty: 1 }, // 0.50
                { pCode: 'APL1K', itemName: 'Apple 1kg', qty: 2 },    // 2.00
            ],
            master,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].groupName).toBe('ஆப்பிள்');
        expect(rows[0].totalQty).toBeCloseTo(3.5, 6);
        expect(rows[0].variantCount).toBe(3);
    });

    it('sums repeated lines of the same variant without inflating the variant count', () => {
        const rows = aggregatePurchaseRows(
            [
                { pCode: 'BEET', itemName: 'Beetroot Ooty', qty: 1 },
                { pCode: 'BEET', itemName: 'Beetroot Ooty', qty: 2 },
            ],
            master,
        );
        expect(rows[0].totalQty).toBeCloseTo(0.75, 6);
        expect(rows[0].variantCount).toBe(1);
    });

    // Quantity-priced items use weight x qty uniformly, same as weight-priced.
    it('treats a pack count as the multiplier for quantity-priced items', () => {
        const rows = aggregatePurchaseRows([{ pCode: 'BAN5', itemName: 'Country Banana 5nos', qty: 1 }], master);
        expect(rows[0].totalQty).toBeCloseTo(5, 6);
    });

    // An unlisted product that vanishes is a product nobody buys.
    it('still prints a product that is missing from the spreadsheet', () => {
        const rows = aggregatePurchaseRows([{ pCode: 'NOPE', itemName: 'Mystery Gourd', qty: 3 }], master);
        expect(rows).toHaveLength(1);
        expect(purchaseLabel(rows[0])).toBe('Mystery Gourd');
        expect(rows[0].totalQty).toBe(0);
    });

    it('keeps two different unmatched products apart', () => {
        const rows = aggregatePurchaseRows(
            [
                { pCode: null, itemName: 'Mystery Gourd', qty: 1 },
                { pCode: null, itemName: 'Mystery Root', qty: 1 },
            ],
            master,
        );
        expect(rows).toHaveLength(2);
    });

    it('falls back to the English name when there is no SKU on the line', () => {
        const rows = aggregatePurchaseRows([{ pCode: null, itemName: 'apple  1KG', qty: 1 }], master);
        expect(rows[0].groupName).toBe('ஆப்பிள்');
    });

    // OrdNo is the kitchen's reading order; a missing one must sink, not float.
    it('sorts by OrdNo and sinks unmatched products to the bottom', () => {
        const rows = aggregatePurchaseRows(
            [
                { pCode: 'APL1K', itemName: 'Apple 1kg', qty: 1 },   // OrdNo 40
                { pCode: 'NOPE', itemName: 'Mystery Gourd', qty: 1 }, // MAX
                { pCode: 'BEET', itemName: 'Beetroot Ooty', qty: 1 }, // OrdNo 10
            ],
            master,
        );
        expect(rows.map(purchaseLabel)).toEqual(['பீட்ரூட்(ஊட்டி)', 'ஆப்பிள்', 'Mystery Gourd']);
    });

    // Within one OrdNo, Tamil collation -- not code-point order, which is not
    // the sequence a Tamil reader scans.
    it('breaks an OrdNo tie with Tamil collation', () => {
        const tie = buildProductMaster([
            { SKU: 'A', 'Tamil Name': 'மாதுளை', 'Product Name': 'Pomegranate', Weight: 1, 'Group Name': 'மாதுளை', OrdNo: 5 },
            { SKU: 'B', 'Tamil Name': 'ஆப்பிள்', 'Product Name': 'Apple', Weight: 1, 'Group Name': 'ஆப்பிள்', OrdNo: 5 },
        ]);
        const rows = aggregatePurchaseRows(
            [
                { pCode: 'A', itemName: 'Pomegranate', qty: 1 },
                { pCode: 'B', itemName: 'Apple', qty: 1 },
            ],
            tie,
        );
        expect(rows.map(purchaseLabel)).toEqual(['ஆப்பிள்', 'மாதுளை']);
    });

    it('returns nothing for no lines, and survives a missing spreadsheet', () => {
        expect(aggregatePurchaseRows([], master)).toEqual([]);
        const noMaster = aggregatePurchaseRows([{ pCode: 'APL1K', itemName: 'Apple 1kg', qty: 2 }], null);
        expect(noMaster).toHaveLength(1);
        expect(purchaseLabel(noMaster[0])).toBe('Apple 1kg');
    });
});

describe('buildProductMaster', () => {
    it('skips spacer and heading rows that have no SKU or no Tamil name', () => {
        const built = buildProductMaster([
            { SKU: 'A', 'Tamil Name': 'ஆப்பிள்', 'Product Name': 'Apple', Weight: 1 },
            { SKU: '', 'Tamil Name': 'FRUITS', 'Product Name': '' },
            { SKU: 'B', 'Tamil Name': '', 'Product Name': 'No Tamil' },
        ]);
        expect(built.rowCount).toBe(1);
    });

    it('accepts every header spelling the hand-maintained sheet has used', () => {
        const built = buildProductMaster([
            { sku: 'A', TamilName: 'ஆப்பிள்', ProductName: 'Apple', weight: '0.5', ordNo: '7' },
        ]);
        expect(built.productsBySku['A'].weight).toBe(0.5);
        expect(built.productsBySku['A'].ordNo).toBe(7);
    });

    // A 0 would float unmatched products to the TOP of the buyer's list.
    it('defaults a missing or unparseable OrdNo to MAX_SAFE_INTEGER, not 0', () => {
        const built = buildProductMaster([
            { SKU: 'A', 'Tamil Name': 'ஆப்பிள்', 'Product Name': 'Apple', OrdNo: 'n/a' },
        ]);
        expect(built.productsBySku['A'].ordNo).toBe(Number.MAX_SAFE_INTEGER);
    });
});
