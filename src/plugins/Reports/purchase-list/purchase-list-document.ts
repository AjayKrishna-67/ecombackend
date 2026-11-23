import { PurchaseRow, purchaseLabel } from './aggregate-purchase-rows';
import { PurchaseReportRow } from './build-purchase-report-rows';

/**
 * The printed Purchase List, as HTML.
 *
 * VERBATIM PORT of the delivery dashboard's `buildPurchaseListDocument`
 * (app/reports/page.tsx:3517) and `FLOW_PAGINATOR_SCRIPT` (:3441). The markup,
 * CSS and paginator are copied character for character on purpose: the
 * scheduled PDF has to be the same document the team prints by hand, not a
 * lookalike. `__tests__/purchase-list-document.spec.ts` pins the structure so a
 * later edit here cannot quietly drift from the dashboard.
 *
 * THREE DELIBERATE DIFFERENCES, all forced by running outside a browser:
 *
 *  1. The logo was `${window.location.origin}/kaaikani_logo.png`. There is no
 *     origin here, and Playwright's setContent has no base URL, so it is passed
 *     in as a data URI. Embedding also removes a network fetch from the render,
 *     which would otherwise be a silent way for the logo to go missing.
 *  2. The header date was `new Date()` on the client. The worker's clock is UTC
 *     while the report is read in India, so a 21:00 IST run would print
 *     tomorrow's date. The caller supplies it, resolved in the schedule's own
 *     timezone.
 *  3. The paginator ended with `window.print()`. Playwright captures the PDF
 *     with page.pdf() instead, and a print dialog in headless Chromium blocks
 *     forever. Gated behind `autoPrint` so the browser path keeps working if
 *     this module is ever served to one.
 *
 * Everything else -- page size, 8mm padding, the 294mm cap, the repeated
 * <thead>, the "X / Y" footer, the greyscale rule and the warning against
 * filtering html/body -- is unchanged.
 */

export interface PurchaseListDocumentOptions {
    /** Printed as "Purchase Product List on DD-MM-YYYY". */
    readonly headerDate: string;
    /** `data:image/png;base64,...`. Omit to render without a logo. */
    readonly logoSrc?: string;
    /** Call window.print() after pagination. False for headless capture. */
    readonly autoPrint?: boolean;
}

/**
 * Continuous-flow paginator (Crystal-Reports style). Packs each A4 sheet full: a
 * one-time `.report-hdr` block on page 1, then every `table.flow` has its rows
 * flowed across sheets with the <thead> repeated. Because the sheets are built
 * here (each `.page` === one physical sheet, @page margin:0) the top/bottom
 * margins stay clean and the "X / Y" page number is always exact.
 *
 * It measures real scrollHeight, which is why this has to run in Chromium and
 * cannot be replaced by a server-side PDF library without changing the output.
 */
function flowPaginatorScript(autoPrint: boolean): string {
    return `
<script>
(function(){
    function paginate(){
        var src = document.getElementById('src');
        if (!src) return;
        var probe = document.createElement('div');
        probe.style.cssText = 'width:100mm;height:100mm;position:absolute;left:-9999px;top:0;visibility:hidden;';
        document.body.appendChild(probe);
        var pxPerMm = probe.offsetHeight / 100;
        document.body.removeChild(probe);
        // A .page's scrollHeight includes its 8mm top+bottom padding (16mm).
        // Cap at 294mm (297 sheet − ~3mm slack) so content never spills onto a
        // sliver page; one .page === one physical sheet.
        var MAX = pxPerMm * 294;

        var pages = [];
        function newPage(){
            var p = document.createElement('div');
            p.className = 'page';
            document.body.appendChild(p);
            pages.push(p);
            return p;
        }
        var cur = newPage();
        function fits(){ return cur.scrollHeight <= MAX; }
        function place(node){
            cur.appendChild(node);
            if (!fits() && cur.childNodes.length > 1) { cur = newPage(); cur.appendChild(node); }
        }

        Array.prototype.slice.call(src.children).forEach(function(node){
            if (node.tagName === 'TABLE') {
                var thead = node.querySelector('thead');
                var rows = Array.prototype.slice.call(node.querySelectorAll('tbody > tr'));
                var cls = node.className;
                function newTbl(){
                    var t = document.createElement('table');
                    t.className = cls;
                    if (thead) t.appendChild(thead.cloneNode(true));
                    t.appendChild(document.createElement('tbody'));
                    return t;
                }
                var tbl = newTbl();
                cur.appendChild(tbl);
                if (!fits() && cur.childNodes.length > 1) { cur = newPage(); cur.appendChild(tbl); }
                var tb = tbl.querySelector('tbody');
                rows.forEach(function(r){
                    tb.appendChild(r);
                    if (!fits()) {
                        tb.removeChild(r);
                        cur = newPage();
                        tbl = newTbl();
                        cur.appendChild(tbl);
                        tb = tbl.querySelector('tbody');
                        tb.appendChild(r);
                    }
                });
            } else {
                place(node);
            }
        });

        src.remove();
        pages.forEach(function(p, i){
            var n = document.createElement('div');
            n.className = 'page-num';
            n.textContent = (i + 1) + ' / ' + pages.length;
            p.appendChild(n);
        });
        // Signals the renderer that layout is final. Polling for this is what
        // makes the capture deterministic instead of a fixed sleep.
        document.documentElement.setAttribute('data-paginated', String(pages.length));
    }
    window.addEventListener('load', function(){
        paginate();${autoPrint ? `
        setTimeout(function(){ window.print(); }, 250);` : ''}
    });
})();
</script>`;
}

/** Minimal HTML escape. Product names come from the spreadsheet and the catalogue. */
export function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The minimal shape the printed table needs. Both the catalogue-driven report
 * and the legacy spreadsheet one adapt into this, so the markup below exists
 * exactly once -- two copies of it would drift, and the printed sheet is the
 * thing the buying team actually acts on.
 */
export interface PurchaseListPrintRow {
    readonly label: string;
    /** Already formatted, including any unit suffix. See formatPurchaseQty. */
    readonly qtyText: string;
}

/**
 * How a quantity reads on paper.
 *
 * Weights keep the historic three decimals -- the sheet is a weighing
 * instruction, so 0.330 and 0.33 are not the same message.
 *
 * Counted rows print "1 Pcs", NOT "1.000". The column is headed "Qty / kg", so
 * a bare 1 against Button Mushroom would be read as one kilogram when it means
 * one box. Carrying the unit is the difference between a buyer picking up a
 * punnet and weighing out a kilo of mushrooms.
 */
export function formatPurchaseQty(row: Pick<PurchaseReportRow, 'totalQty' | 'unitKind' | 'unitLabel'>): string {
    if (row.unitKind === 'COUNT') {
        // Whole units; a fractional pack is not a thing anyone can buy.
        return `${Math.round(row.totalQty)} ${row.unitLabel}`;
    }
    if (row.unitKind === 'VOLUME') {
        return `${row.totalQty.toFixed(3)} ${row.unitLabel}`;
    }
    return row.totalQty.toFixed(3);
}

/** Adapts catalogue-driven report rows onto the printed table. */
export function toPrintRows(rows: readonly PurchaseReportRow[]): PurchaseListPrintRow[] {
    return rows.map(r => ({
        // A row where any of the quantity is an ordered count rather than a
        // measurement is marked so the buyer can see which numbers to trust.
        // Silent would make a guess indistinguishable from a fact.
        label: r.incomplete ? `${r.label} *` : r.label,
        qtyText: formatPurchaseQty(r),
    }));
}

/** Adapts the legacy spreadsheet rows onto the same table. */
export function legacyToPrintRows(rows: readonly PurchaseRow[]): PurchaseListPrintRow[] {
    return rows.map(r => ({ label: purchaseLabel(r), qtyText: r.totalQty.toFixed(3) }));
}

export function buildPurchaseListDocument(
    rows: readonly PurchaseListPrintRow[],
    options: PurchaseListDocumentOptions,
): string {
    const { headerDate, logoSrc = '', autoPrint = false } = options;

    const rowsHtml = rows.map(r => `
            <tr>
                <td class="td tamil">${escapeHtml(r.label)}</td>
                <td class="td num"><b>${escapeHtml(r.qtyText)}</b></td>
            </tr>`).join('');

    const logoHtml = logoSrc
        ? `<img class="brand-logo" src="${logoSrc}" alt="KAAIKANI" />`
        : '';

    return `<!DOCTYPE html>
<html lang="ta">
<head>
<meta charset="utf-8" />
<title>KAAIKANI</title>
<style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
        font-family: Arial, "Segoe UI", "Noto Sans Tamil", "Latha", "Tamil MN", "Mangal", sans-serif;
        font-size: 9.5pt;
        color: #000;
        background: #fff;
    }
    .page { width: 210mm; padding: 8mm 10mm; position: relative; page-break-after: always; }
    .page:last-child { page-break-after: auto; }
    .page-num { position: absolute; right: 10mm; bottom: 4mm; font-size: 8pt; color: #000; }
    .report-hdr { padding-bottom: 4px; border-bottom: 1.5pt solid #000; margin-bottom: 6px; }
    .brand-row { display: flex; align-items: center; justify-content: center; margin: 0; line-height: 0; }
    .brand-logo { display: block; height: 34px; width: auto; margin: 0; }
    .report-hdr .row { text-align: center; margin-top: 4px; font-size: 10pt; }
    table.purchase { width: 100%; border-collapse: collapse; }
    .purchase .th, .purchase .td { border: 1px solid #000; padding: 5px 6px; }
    .purchase .th { background: #fff; font-weight: bold; text-align: left; font-size: 10pt; }
    .purchase .item { width: 70%; }
    .purchase .qty { width: 30%; text-align: center; }
    .purchase .num { text-align: center; font-size: 9.5pt; }
    .tamil { font-family: "Noto Sans Tamil", "Latha", "Tamil MN", "Mangal", Arial, sans-serif; font-size: 10pt; }
    /* margin: 0 on @page suppresses Chrome's default URL/title/date headers + footers. */
    @page { size: A4; margin: 0; }
    /* Force pure black-and-white output: the report content is already colourless,
       and this strips any colour from the logo/images so the printer never pulls
       the colour cartridge — even if the print dialog is left on "Colour". */
    .brand-logo, img { filter: grayscale(100%); }
    /* NOTE: do NOT put a CSS filter on html/body here. A filter on a page
       container forces the browser to rasterize the whole page to a bitmap when
       printing -- the PDF then looks identical but its text is an image, so it
       cannot be searched or selected (in every browser). The report content is
       already black-and-white and the logo is greyscaled via the rule above, so
       only the color-adjust hints are needed. */
    @media print { html { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div id="src">
    <header class="report-hdr">
        <div class="brand-row">
            ${logoHtml}
        </div>
        <div class="row"><b>Purchase Product List on ${escapeHtml(headerDate)}</b></div>
    </header>
    <table class="purchase flow">
        <thead>
            <tr>
                <th class="th item">Item Name</th>
                <th class="th qty">Qty&nbsp;/&nbsp;kg</th>
            </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
    </table>
</div>
${flowPaginatorScript(autoPrint)}
</body>
</html>`;
}

/**
 * "DD-MM-YYYY" in the given IANA zone.
 *
 * Not `toISOString().slice(...)`: that is UTC, so a report generated at 21:00
 * Asia/Kolkata would be stamped with tomorrow's date -- the single most likely
 * way for a scheduled report to look wrong to the person reading it.
 */
export function formatHeaderDate(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('day')}-${get('month')}-${get('year')}`;
}
