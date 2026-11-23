import { describe, expect, it } from 'vitest';

import { toMeasure, EMPTY_MEASURE } from '../../../Stock/shared/measurement';
import {
    buildPurchaseReportRows,
    PurchaseLineInput,
    resolveOrdNo,
} from '../build-purchase-report-rows';

/**
 * Default is a weight-pooled product: `productStockEnabled` is the tinyint 1 the
 * driver actually returns, not `true`, so every test also exercises the coercion.
 */
function line(over: Partial<PurchaseLineInput> = {}): PurchaseLineInput {
    return {
        productId: 'p1',
        variantId: 'v1',
        quantity: 1,
        measure: toMeasure(500, 'g', 'option'),
        localName: 'ஆப்பிள்',
        productName: 'Apple',
        variantLocalName: null,
        variantName: 'Apple 500gm',
        productStockEnabled: 1,
        ordNos: [1],
        ...over,
    };
}

describe('buildPurchaseReportRows — the two questions the Qty column answers', () => {
    // "product A has 15 orders and each order 500gms means totally 7.5kg"
    it('sums a weighed product into kilograms', () => {
        const rows = buildPurchaseReportRows([line({ quantity: 15 })]);
        expect(rows[0].totalQty).toBeCloseTo(7.5, 6);
        expect(rows[0].unitKind).toBe('WEIGHT');
        expect(rows[0].unitLabel).toBe('kg');
    });

    // "6 piece pack ordered 5 times should be 30 not 5 pcs" -- the pack
    // magnitude multiplies through for counted units exactly as grams do.
    it('multiplies a counted pack size by the ordered quantity', () => {
        const rows = buildPurchaseReportRows([
            line({ measure: toMeasure(6, 'piece', 'option'), quantity: 5, productName: 'Eggs' }),
        ]);
        expect(rows[0].totalQty).toBe(30);
        expect(rows[0].unitKind).toBe('COUNT');
        expect(rows[0].unitLabel).toBe('Pcs');
    });

    // "paneer are packets: one pack should be 1, two packs should be 2" -- a
    // paneer packet is authored as 1 packet, so its 200 g label never enters
    // the sum. The gram figure belongs in the option NAME, not measureValue.
    it('counts a one-per-pack product as its ordered quantity', () => {
        const rows = buildPurchaseReportRows([
            line({ measure: toMeasure(1, 'packet', 'option'), quantity: 2, productName: 'Paneer' }),
        ]);
        expect(rows[0].totalQty).toBe(2);
        expect(rows[0].unitKind).toBe('COUNT');
    });

    // "lemon 5 nos for 1 quantity should be 5*1=5, 5 nos for 5 quantity should
    // be 5*5=25" -- a nos option's value IS the count per unit ordered.
    it('multiplies a nos option by the ordered quantity', () => {
        const one = buildPurchaseReportRows([
            line({ measure: toMeasure(5, 'piece', 'option'), quantity: 1, productName: 'Lemon' }),
        ]);
        const five = buildPurchaseReportRows([
            line({ measure: toMeasure(5, 'piece', 'option'), quantity: 5, productName: 'Lemon' }),
        ]);
        expect(one[0].totalQty).toBe(5);
        expect(five[0].totalQty).toBe(25);
    });

    it('sums a volume product into litres', () => {
        const rows = buildPurchaseReportRows([
            line({ measure: toMeasure(1, 'litre', 'option'), quantity: 3 }),
        ]);
        expect(rows[0].totalQty).toBeCloseTo(3, 6);
        expect(rows[0].unitLabel).toBe('l');
    });

    it('rolls every pack size of one product into a single row', () => {
        const rows = buildPurchaseReportRows([
            line({ variantId: 'v250', measure: toMeasure(250, 'g', 'option'), quantity: 4 }), // 1.0
            line({ variantId: 'v500', measure: toMeasure(500, 'g', 'option'), quantity: 1 }), // 0.5
            line({ variantId: 'v1k', measure: toMeasure(1, 'kg', 'option'), quantity: 2 }),   // 2.0
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].totalQty).toBeCloseTo(3.5, 6);
        expect(rows[0].variantCount).toBe(3);
    });

    // Adding kilograms to pieces is a category error, not an arithmetic one.
    it('splits a product whose variants mix units into one row per unit', () => {
        const rows = buildPurchaseReportRows([
            line({ variantId: 'w', measure: toMeasure(1, 'kg', 'option'), quantity: 2 }),
            line({ variantId: 'c', measure: toMeasure(1, 'piece', 'option'), quantity: 3 }),
        ]);
        expect(rows).toHaveLength(2);
        expect(rows.find(r => r.unitKind === 'WEIGHT')!.totalQty).toBeCloseTo(2, 6);
        expect(rows.find(r => r.unitKind === 'COUNT')!.totalQty).toBe(3);
    });

});

describe('buildPurchaseReportRows — labelling', () => {
    it('prints the localName', () => {
        expect(buildPurchaseReportRows([line()])[0].label).toBe('ஆப்பிள்');
    });

    // localName is populated on 1 of 752 products, so the fallback is the
    // normal case today, not an edge case.
    it('falls back to the product name when localName is unset or blank', () => {
        expect(buildPurchaseReportRows([line({ localName: null })])[0].label).toBe('Apple');
        expect(buildPurchaseReportRows([line({ localName: '   ' })])[0].label).toBe('Apple');
    });

    it('prints the variant localName on a variant-scoped row', () => {
        const rows = buildPurchaseReportRows([
            line({ productStockEnabled: 0, variantLocalName: 'ஆப்பிள் 500கி' }),
        ]);
        expect(rows[0].label).toBe('ஆப்பிள் 500கி');
    });

    // Never Product.localName: three flavours would print as three identical
    // Tamil rows carrying different numbers, which the buyer cannot act on.
    it('falls back to the variant name, NOT the product localName, on a variant row', () => {
        const rows = buildPurchaseReportRows([
            line({ productStockEnabled: 0, variantLocalName: '  ' }),
        ]);
        expect(rows[0].label).toBe('Apple 500gm');
    });
});

describe('buildPurchaseReportRows — product rows vs variant rows', () => {
    // The reason the split exists: mango, greek and blueberry are three entries
    // on the supplier's invoice, not one. What marks them as distinct is that
    // the merchant stocks them per variant -- not that they are counted.
    it('gives every flavour of a per-variant-stock product its own row', () => {
        const yoghurt = (variantId: string, variantLocalName: string, quantity: number) =>
            line({
                productId: 'p-yoghurt',
                variantId,
                variantLocalName,
                quantity,
                measure: toMeasure(1, 'piece', 'option'),
                localName: 'மில்கி மிஸ்ட் தயிர்',
                productStockEnabled: 0,
            });
        const rows = buildPurchaseReportRows([
            yoghurt('v-mango', 'மாங்கோ', 5),
            yoghurt('v-greek', 'கிரீக்', 7),
            yoghurt('v-blue', 'ப்ளூபெர்ரி', 15),
        ]);
        expect(rows).toHaveLength(3);
        expect(rows.every(r => r.scope === 'VARIANT')).toBe(true);
        expect(rows.every(r => r.variantCount === 1)).toBe(true);
        expect(new Map(rows.map(r => [r.label, r.totalQty]))).toEqual(
            new Map([
                ['மாங்கோ', 5],
                ['கிரீக்', 7],
                ['ப்ளூபெர்ரி', 15],
            ]),
        );
    });

    // Amla 10 nos and 25 nos are one crate of amla. Found on the Madurai sheet
    // as two rows, "நெல்லிக்காய் (10 எண்ணிக்கை)" and "நெல்லிக்காய் (25 எண்ணிக்கை)".
    it('rolls counted pack sizes of a pooled product into one row of pieces', () => {
        const amla = (variantId: string, nos: number, quantity: number) =>
            line({
                productId: 'p-amla',
                variantId,
                variantName: `Amla ${nos} no.`,
                variantLocalName: `நெல்லிக்காய் (${nos} எண்ணிக்கை)`,
                measure: toMeasure(nos, 'piece', 'option'),
                quantity,
                localName: 'நெல்லிக்காய்',
                productName: 'Amla',
            });
        const rows = buildPurchaseReportRows([amla('v10', 10, 2), amla('v25', 25, 1)]);
        expect(rows).toHaveLength(1);
        expect(rows[0].scope).toBe('PRODUCT');
        expect(rows[0].label).toBe('நெல்லிக்காய்');
        expect(rows[0].totalQty).toBe(45);
        expect(rows[0].unitKind).toBe('COUNT');
        expect(rows[0].variantCount).toBe(2);
        expect(rows[0].incomplete).toBe(false);
    });

    // Three pack sizes off one crate: which pack it becomes is a packing
    // decision made after the buying, so the buyer wants one number.
    it('keeps a weight-pooled weighed product as a single product row', () => {
        const rows = buildPurchaseReportRows([
            line({ variantId: 'v250', measure: toMeasure(250, 'g', 'option'), quantity: 4 }),
            line({ variantId: 'v1k', measure: toMeasure(1, 'kg', 'option'), quantity: 2 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].scope).toBe('PRODUCT');
        expect(rows[0].variantId).toBeNull();
        expect(rows[0].label).toBe('ஆப்பிள்');
        expect(rows[0].totalQty).toBeCloseTo(3, 6);
    });

    // Per-variant stock means the merchant already treats them as distinct.
    it('splits a weighed product that is NOT weight-pooled', () => {
        const rows = buildPurchaseReportRows([
            line({ variantId: 'v250', variantName: 'Apple 250gm', productStockEnabled: 0, measure: toMeasure(250, 'g', 'option'), quantity: 4 }),
            line({ variantId: 'v1k', variantName: 'Apple 1kg', productStockEnabled: 0, measure: toMeasure(1, 'kg', 'option'), quantity: 2 }),
        ]);
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.scope)).toEqual(['VARIANT', 'VARIANT']);
        expect(rows.find(r => r.label === 'Apple 250gm')!.totalQty).toBeCloseTo(1, 6);
        expect(rows.find(r => r.label === 'Apple 1kg')!.totalQty).toBeCloseTo(2, 6);
    });

    // THE trap. EMPTY_MEASURE carries baseUnit 'piece', so an ungated COUNT rule
    // would shatter every unmeasured product into one row per pack size, each
    // wearing its own variant name -- an exploded sheet that looks deliberate.
    it('does NOT split a pooled product whose variants have no measurement', () => {
        const rows = buildPurchaseReportRows([
            line({ variantId: 'a', measure: EMPTY_MEASURE, quantity: 2, productName: 'Tomato' }),
            line({ variantId: 'b', measure: EMPTY_MEASURE, quantity: 3, productName: 'Tomato' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].scope).toBe('PRODUCT');
        expect(rows[0].totalQty).toBe(5);
        expect(rows[0].incomplete).toBe(true);
    });

    // A pooled product with one measured pack and one unmeasured pack is still
    // one row -- and the one unmeasured line makes the whole number a guess.
    it('rolls a measured and an unmeasured pack into one row and flags it', () => {
        const rows = buildPurchaseReportRows([
            line({ variantId: 'm', variantName: 'Paneer 200gm', measure: toMeasure(1, 'packet', 'option'), quantity: 4 }),
            line({ variantId: 'u', measure: EMPTY_MEASURE, quantity: 3 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].scope).toBe('PRODUCT');
        expect(rows[0].totalQty).toBe(7);
        expect(rows[0].incomplete).toBe(true);
    });

    // 1 === true is false. Getting this wrong reads every product as
    // per-variant and shatters the entire sheet -- plausibly, and silently.
    it('reads the MySQL tinyint 1 as pooled, not as false', () => {
        expect(buildPurchaseReportRows([line({ productStockEnabled: 1 })])[0].scope).toBe('PRODUCT');
        expect(buildPurchaseReportRows([line({ productStockEnabled: true })])[0].scope).toBe('PRODUCT');
        expect(buildPurchaseReportRows([line({ productStockEnabled: 0 })])[0].scope).toBe('VARIANT');
        expect(buildPurchaseReportRows([line({ productStockEnabled: null })])[0].scope).toBe('VARIANT');
    });

    // The catalogue holds the same produce created twice as separate products
    // (Idukki's பீட்ரூட்(ஊட்டி)). The buyer reads one label, so one row.
    it('merges two products that print the same label', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'p-a', variantId: 'a1', localName: 'பீட்ரூட்(ஊட்டி)', measure: toMeasure(500, 'g', 'option'), quantity: 1 }),
            line({ productId: 'p-b', variantId: 'b1', localName: 'பீட்ரூட்(ஊட்டி)', measure: toMeasure(250, 'g', 'option'), quantity: 1 }),
            line({ productId: 'p-b', variantId: 'b2', localName: 'பீட்ரூட்(ஊட்டி)', measure: toMeasure(500, 'g', 'option'), quantity: 1 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].label).toBe('பீட்ரூட்(ஊட்டி)');
        expect(rows[0].totalQty).toBeCloseTo(1.25, 6);
        expect(rows[0].variantCount).toBe(3);
        expect(rows[0].scope).toBe('PRODUCT');
        expect(rows[0].variantId).toBeNull();
    });

    it('merges on the label as read: whitespace, composition and case do not split it', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'p-a', variantId: 'a1', localName: 'பீட்ரூட்  (ஊட்டி) ' }),
            line({ productId: 'p-b', variantId: 'b1', localName: 'பீட்ரூட் (ஊட்டி)'.normalize('NFD') }),
            line({ productId: 'p-c', variantId: 'c1', localName: null, productName: 'Beetroot (Ooty)' }),
            line({ productId: 'p-d', variantId: 'd1', localName: null, productName: 'beetroot (ooty)' }),
        ]);
        expect(rows.map(r => r.variantCount).sort()).toEqual([2, 2]);
    });

    // Kilograms and pieces of one label are two questions, not one.
    it('does not merge the same label across units', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'p-a', variantId: 'a1', localName: 'எலுமிச்சை', measure: toMeasure(1, 'kg', 'option') }),
            line({ productId: 'p-b', variantId: 'b1', localName: 'எலுமிச்சை', measure: toMeasure(5, 'piece', 'option') }),
        ]);
        expect(rows).toHaveLength(2);
    });

    // A merged row sorts by the lowest section either duplicate carried, and is
    // flagged if either half was.
    it('takes the lowest section and any incompleteness into a merged row', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'p-a', variantId: 'a1', localName: 'பீட்ரூட்', ordNos: [], measure: toMeasure(10, 'piece', 'option') }),
            line({ productId: 'p-b', variantId: 'b1', localName: 'பீட்ரூட்', ordNos: [1], measure: EMPTY_MEASURE }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].ordNo).toBe(1);
        expect(rows[0].incomplete).toBe(true);
    });

    // Product 971 and variant 971 both exist in this catalogue.
    it('does not merge a variant row into a product row with the same numeric id', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: '971', variantId: 'v-a', productStockEnabled: 1, measure: toMeasure(1, 'kg', 'option'), quantity: 2 }),
            line({ productId: 'p-other', variantId: '971', productStockEnabled: 0, measure: toMeasure(1, 'kg', 'option'), quantity: 5 }),
        ]);
        expect(rows).toHaveLength(2);
    });

    // Section comes from the PRODUCT's facets, so siblings stay together.
    it('keeps variant rows of one product adjacent, Tamil-collated within', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'other', variantId: 'z', ordNos: [1], localName: 'கேரட்' }),
            line({ productId: 'y', variantId: 'v2', ordNos: [2], productStockEnabled: 0, variantLocalName: 'மாதுளை' }),
            line({ productId: 'y', variantId: 'v1', ordNos: [2], productStockEnabled: 0, variantLocalName: 'ஆப்பிள்' }),
        ]);
        expect(rows.map(r => r.label)).toEqual(['கேரட்', 'ஆப்பிள்', 'மாதுளை']);
    });
});

describe('buildPurchaseReportRows — sections', () => {
    it('sorts by section, then Tamil collation within a section', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'f', ordNos: [2], localName: 'மாதுளை' }),
            line({ productId: 'v', ordNos: [1], localName: 'கேரட்' }),
            line({ productId: 'f2', ordNos: [2], localName: 'ஆப்பிள்' }),
        ]);
        expect(rows.map(r => r.label)).toEqual(['கேரட்', 'ஆப்பிள்', 'மாதுளை']);
    });

    // A 0 default would put unclassified products at the TOP of the sheet.
    it('sinks an untagged product to the bottom with a null section', () => {
        const rows = buildPurchaseReportRows([
            line({ productId: 'x', ordNos: [], localName: 'Untagged' }),
            line({ productId: 'v', ordNos: [1], localName: 'கேரட்' }),
        ]);
        expect(rows.map(r => r.ordNo)).toEqual([1, null]);
    });

    // EMPTY_MEASURE carries baseUnit 'piece', so an unmeasured weighed vegetable
    // would print a confident "4 Pcs". It still shows the ordered count -- a
    // product missing from the sheet is a product nobody buys -- but must be
    // flagged, or a guess is indistinguishable from a fact.
    it('shows the ordered count for an unmeasured product but marks it incomplete', () => {
        const rows = buildPurchaseReportRows([
            line({ measure: EMPTY_MEASURE, quantity: 4, productName: 'Mystery Gourd' }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].totalQty).toBe(4);
        expect(rows[0].incomplete).toBe(true);
    });

    it('does not flag a measured row as incomplete', () => {
        expect(buildPurchaseReportRows([line()])[0].incomplete).toBe(false);
    });
});

describe('resolveOrdNo', () => {
    // The duplicate-facet problem: "Vegetables" exists as facet values 2, 86 and
    // 107. Tag them all 1 and a product carrying any of them lands in section 1.
    it('takes the lowest section when a product carries several tagged facets', () => {
        expect(resolveOrdNo([5, 1, 9])).toBe(1);
    });

    it('returns null when nothing is tagged', () => {
        expect(resolveOrdNo([])).toBeNull();
    });

    it('ignores non-finite values rather than producing NaN', () => {
        expect(resolveOrdNo([NaN, 3])).toBe(3);
        expect(resolveOrdNo([NaN])).toBeNull();
    });
});
