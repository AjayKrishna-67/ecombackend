import { describe, expect, it } from 'vitest';

import { PurchaseRow } from '../aggregate-purchase-rows';
import {
    buildPurchaseListDocument,
    escapeHtml,
    formatHeaderDate,
    formatPurchaseQty,
    legacyToPrintRows,
    toPrintRows,
} from '../purchase-list-document';

/**
 * These pin the printed document against the delivery dashboard's
 * `buildPurchaseListDocument` (app/reports/page.tsx:3517). The scheduled PDF has
 * to BE the sheet the team prints by hand, not a lookalike, and the two copies
 * of this markup now live in different repos -- so every rule that would be
 * visible on paper is asserted here. If one of these fails, the two documents
 * have drifted and the printed output has changed.
 */
function row(over: Partial<PurchaseRow> = {}): PurchaseRow {
    return {
        key: 'k',
        groupName: 'ஆப்பிள்',
        tamilName: '',
        englishName: 'Apple',
        totalQty: 2,
        ordNo: 1,
        category: 'Fruits',
        variantCount: 1,
        ...over,
    };
}

const opts = { headerDate: '05-08-2026' };

describe('buildPurchaseListDocument — what lands on paper', () => {
    it('titles the sheet with the supplied date', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).toContain(
            '<b>Purchase Product List on 05-08-2026</b>',
        );
    });

    it('prints the two columns the buyer reads', () => {
        const html = buildPurchaseListDocument(legacyToPrintRows([row()]), opts);
        expect(html).toContain('<th class="th item">Item Name</th>');
        expect(html).toContain('<th class="th qty">Qty&nbsp;/&nbsp;kg</th>');
    });

    // 0.330 not 0.33 -- the sheet is read as a weighing instruction.
    it('always shows three decimal places', () => {
        const html = buildPurchaseListDocument(legacyToPrintRows([row({ totalQty: 0.33 })]), opts);
        expect(html).toContain('<b>0.330</b>');
        expect(html).toContain('<b>15.000</b>'.replace('15.000', '0.330'));
    });

    it('labels a row Tamil group first, then Tamil variant, then English', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).toContain('>ஆப்பிள்<');
        expect(
            buildPurchaseListDocument(legacyToPrintRows([row({ groupName: '', tamilName: 'வாழை' })]), opts),
        ).toContain('>வாழை<');
        expect(
            buildPurchaseListDocument(legacyToPrintRows([row({ groupName: '', tamilName: '' })]), opts),
        ).toContain('>Apple<');
    });

    it('keeps A4 with zero page margin, which is what suppresses Chrome headers', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).toContain('@page { size: A4; margin: 0; }');
    });

    // A filter on html/body rasterizes the page: the PDF looks the same but its
    // text stops being selectable or searchable. Only the logo may be filtered.
    it('greyscales only images, never the page container', () => {
        const html = buildPurchaseListDocument(legacyToPrintRows([row()]), opts);
        expect(html).toContain('.brand-logo, img { filter: grayscale(100%); }');
        expect(html).not.toMatch(/(?:^|\s)(?:html|body)\s*\{[^}]*filter:/);
    });

    it('carries the Tamil font stack on the item column', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).toContain(
            '.tamil { font-family: "Noto Sans Tamil", "Latha", "Tamil MN", "Mangal", Arial, sans-serif;',
        );
    });

    it('caps a sheet at 294mm so content never spills onto a sliver page', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).toContain('pxPerMm * 294');
    });

    it('numbers pages X / Y after pagination', () => {
        const html = buildPurchaseListDocument(legacyToPrintRows([row()]), opts);
        expect(html).toContain("(i + 1) + ' / ' + pages.length");
    });

    // Headless capture must not open a print dialog -- it never returns.
    it('omits window.print() unless autoPrint is asked for', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).not.toContain('window.print()');
        expect(
            buildPurchaseListDocument(legacyToPrintRows([row()]), { ...opts, autoPrint: true }),
        ).toContain('window.print()');
    });

    // The renderer polls this instead of sleeping a fixed time.
    it('marks the document paginated with the final page count', () => {
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).toContain("setAttribute('data-paginated'");
    });

    it('embeds the logo inline and omits the tag entirely when absent', () => {
        const withLogo = buildPurchaseListDocument(legacyToPrintRows([row()]), { ...opts, logoSrc: 'data:image/png;base64,AAA' });
        expect(withLogo).toContain('src="data:image/png;base64,AAA"');
        expect(buildPurchaseListDocument(legacyToPrintRows([row()]), opts)).not.toContain('<img');
    });

    it('escapes a product name that contains markup', () => {
        expect(
            buildPurchaseListDocument(legacyToPrintRows([row({ groupName: 'A & <b>B</b>' })]), opts),
        ).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
    });

    it('renders an empty tbody rather than failing when nothing was ordered', () => {
        const html = buildPurchaseListDocument(legacyToPrintRows([]), opts);
        expect(html).toContain('<tbody></tbody>');
    });
});

describe('formatHeaderDate', () => {
    // The failure this prevents: a 21:00 IST run stamped with tomorrow's date,
    // because the worker's clock is UTC.
    it('uses the given zone, not the server clock', () => {
        const lateEvening = new Date('2026-08-05T18:30:00Z'); // 00:00 IST on the 6th
        expect(formatHeaderDate(lateEvening, 'Asia/Kolkata')).toBe('06-08-2026');
        expect(formatHeaderDate(lateEvening, 'UTC')).toBe('05-08-2026');
    });

    it('zero-pads to DD-MM-YYYY', () => {
        expect(formatHeaderDate(new Date('2026-01-02T06:00:00Z'), 'Asia/Kolkata')).toBe('02-01-2026');
    });
});

describe('escapeHtml', () => {
    it('escapes the five characters that can break out of markup', () => {
        expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });

    it('leaves Tamil text untouched', () => {
        expect(escapeHtml('கறிவேப்பிலை')).toBe('கறிவேப்பிலை');
    });
});

describe('formatPurchaseQty — the unit must survive onto paper', () => {
    // The column is headed "Qty / kg", so a bare 1 against Button Mushroom reads
    // as one KILOGRAM when it means one box. Carrying the unit is the difference
    // between the buyer picking up a punnet and weighing out a kilo of mushrooms.
    it('prints counted rows with their unit, not as a weight', () => {
        expect(formatPurchaseQty({ totalQty: 1, unitKind: 'COUNT', unitLabel: 'Pcs' })).toBe('1 Pcs');
    });

    it('rounds a counted row to whole packs — half a punnet is not purchasable', () => {
        expect(formatPurchaseQty({ totalQty: 2.4, unitKind: 'COUNT', unitLabel: 'Pcs' })).toBe('2 Pcs');
    });

    // Weights keep three decimals: the sheet is a weighing instruction, so
    // 0.330 and 0.33 are not the same message.
    it('keeps three decimals for weights and adds no unit', () => {
        expect(formatPurchaseQty({ totalQty: 0.33, unitKind: 'WEIGHT', unitLabel: 'kg' })).toBe('0.330');
        expect(formatPurchaseQty({ totalQty: 17.5, unitKind: 'WEIGHT', unitLabel: 'kg' })).toBe('17.500');
    });

    it('labels volumes so litres are not read as kilograms', () => {
        expect(formatPurchaseQty({ totalQty: 2, unitKind: 'VOLUME', unitLabel: 'l' })).toBe('2.000 l');
    });
});

describe('toPrintRows', () => {
    const base = {
        ordNo: 1, productId: 'p', variantId: null, scope: 'PRODUCT' as const,
        totalQty: 5, unitKind: 'COUNT' as const,
        unitLabel: 'Pcs', variantCount: 1, incomplete: false,
    };

    it('carries the label and the formatted quantity through', () => {
        expect(toPrintRows([{ ...base, label: 'Mushroom' }])).toEqual([
            { label: 'Mushroom', qtyText: '5 Pcs' },
        ]);
    });

    // An unmeasured row's quantity is the ordered COUNT, not a computed weight.
    // Unmarked, a guess is indistinguishable from a fact on the printed sheet.
    it('marks an incomplete row so the buyer knows which numbers to trust', () => {
        expect(toPrintRows([{ ...base, label: 'Mystery', incomplete: true }])[0].label).toBe('Mystery *');
    });
});
