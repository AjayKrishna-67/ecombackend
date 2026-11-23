import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import { DeliveryBill, DeliveryBillLine } from '../functions/delivery-bill';
import { WhatsappInvoiceSeller } from '../types';
import { resolveAsset } from './invoice-pdf.service';

const MARGIN_X = 28; // 10 mm, as the dashboard's .page padding
const MARGIN_Y = 23; // 8 mm
const INK = '#000000';
const CELL_PAD_X = 4;
const CELL_PAD_Y = 3;
const TAMIL_FONT = 'fonts/NotoSansTamil-Bold.ttf';
const MALAYALAM_FONT = 'fonts/NotoSansMalayalam-Bold.ttf';

interface Column {
    title: string;
    width: number;
    align: 'left' | 'center' | 'right';
}

// Widths sum to the A4 content width (595 − 2 × MARGIN_X = 539).
const COLUMNS: Column[] = [
    { title: '#', width: 20, align: 'center' },
    { title: 'ITEM DESCRIPTION', width: 180, align: 'left' },
    { title: 'HSN', width: 45, align: 'center' },
    { title: 'QTY', width: 30, align: 'right' },
    { title: 'MRP', width: 45, align: 'right' },
    { title: 'RATE', width: 45, align: 'right' },
    { title: 'TAX', width: 55, align: 'center' },
    { title: 'GST', width: 60, align: 'center' },
    { title: 'AMOUNT', width: 59, align: 'right' },
];
const ITEM_COLUMN = 1;
const AMOUNT_COLUMN = COLUMNS.length - 1;

/**
 * Renders the bill the delivery dashboard prints (Delivery-PWA
 * app/reports/page.tsx buildBillHtml): black and white, the catalogue's Tamil
 * (or Malayalam) name under each item, discounts as their own rows. pdfkit
 * shapes Tamil and Malayalam correctly with the bundled Noto fonts.
 */
@Injectable()
export class DeliveryBillPdfService {
    render(bill: DeliveryBill, seller: WhatsappInvoiceSeller): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X },
                info: { Title: `Invoice ${bill.invoiceNo}` },
            });
            const chunks: Buffer[] = [];
            doc.on('data', chunk => chunks.push(chunk as Buffer));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            try {
                const localFonts = this.registerLocalFonts(doc);
                this.drawHeader(doc, seller);
                this.drawInfo(doc, bill);
                this.drawItems(doc, bill.lines, localFonts);
                this.drawFooter(doc, bill, seller);
                doc.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    /** Names of the catalogue-name fonts that were found and registered. */
    private registerLocalFonts(doc: PDFKit.PDFDocument): Set<string> {
        const registered = new Set<string>();
        for (const [name, file] of [
            ['tamil', TAMIL_FONT],
            ['malayalam', MALAYALAM_FONT],
        ]) {
            const fontPath = resolveAsset(file);
            if (fontPath) {
                doc.registerFont(name, fontPath);
                registered.add(name);
            }
        }
        return registered;
    }

    /** Centred logo and store address over a heavy rule; no company name, as on the printed bill. */
    private drawHeader(doc: PDFKit.PDFDocument, seller: WhatsappInvoiceSeller): void {
        const width = contentWidth(doc);
        let y = doc.y;
        const logoPath = resolveAsset(seller.logoFile);
        if (logoPath) {
            const height = 26;
            doc.image(logoPath, MARGIN_X, y, { fit: [width, height], align: 'center' });
            y += height + 3;
        }
        doc.font('Helvetica').fontSize(8.5).fillColor(INK);
        doc.text(seller.headOffice, MARGIN_X, y, { width, align: 'center' });
        for (const phone of seller.phones) {
            doc.text(phone, MARGIN_X, doc.y, { width, align: 'center' });
        }
        doc.y += 3;
        this.hRule(doc, MARGIN_X, MARGIN_X + width, doc.y, 1.5);
        doc.y += 3;
    }

    /** Two boxed cells: invoice details in a 2-column grid, then BILL TO. */
    private drawInfo(doc: PDFKit.PDFDocument, bill: DeliveryBill): void {
        const top = doc.y;
        const half = contentWidth(doc) / 2;
        const pad = 6;
        const fields: Array<[string, string]> = [
            ['INVOICE NO:', bill.invoiceNo],
            ['DATE:', bill.dateTime],
            ['ORDER:', bill.orderCode],
            ['PAYMENT:', bill.payment],
            ['DELIVERY:', bill.delivery],
        ];
        const gridWidth = (half - pad * 2 - 12) / 2;
        let leftBottom = top + pad;
        for (let i = 0; i < fields.length; i += 2) {
            const rowTop = leftBottom;
            let rowBottom = rowTop;
            for (let col = 0; col < 2 && i + col < fields.length; col++) {
                const [label, value] = fields[i + col];
                const x = MARGIN_X + pad + col * (gridWidth + 12);
                doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(`${label} `, x, rowTop, {
                    width: gridWidth,
                    continued: true,
                });
                doc.font('Helvetica').fontSize(8.5).text(value || '—');
                rowBottom = Math.max(rowBottom, doc.y);
            }
            leftBottom = rowBottom + 3;
        }

        const rightX = MARGIN_X + half + pad;
        const rightWidth = half - pad * 2;
        doc.font('Helvetica-Bold').fontSize(8).text('BILL TO', rightX, top + pad, { width: rightWidth });
        doc.fontSize(10).text(bill.billName + (bill.billPhone ? ` · ${bill.billPhone}` : ''), rightX, doc.y + 2, {
            width: rightWidth,
        });
        if (bill.billAddress) {
            doc.font('Helvetica').fontSize(9).text(bill.billAddress, rightX, doc.y + 2, { width: rightWidth, lineGap: 1.5 });
        }
        if (bill.note) {
            doc.font('Helvetica-Bold').fontSize(8.5).text('Note: ', rightX, doc.y + 3, { width: rightWidth, continued: true });
            doc.font('Helvetica').text(bill.note);
        }
        const bottom = Math.max(leftBottom, doc.y + pad);
        doc.lineWidth(0.75).strokeColor(INK);
        doc.rect(MARGIN_X, top, half, bottom - top).stroke();
        doc.rect(MARGIN_X + half, top, half, bottom - top).stroke();
        doc.y = bottom + 3;
    }

    private drawItems(doc: PDFKit.PDFDocument, lines: DeliveryBillLine[], localFonts: Set<string>): void {
        this.drawHeaderRow(doc);
        lines.forEach((line, index) => this.drawLine(doc, line, index, localFonts));
        doc.y += 3;
    }

    private drawHeaderRow(doc: PDFKit.PDFDocument): void {
        doc.font('Helvetica-Bold').fontSize(8.5);
        const height = 8.5 + CELL_PAD_Y * 2 + 2;
        const y = doc.y;
        let x = MARGIN_X;
        for (const col of COLUMNS) {
            doc.lineWidth(0.75).strokeColor(INK).rect(x, y, col.width, height).stroke();
            doc.fillColor(INK).text(col.title, x + CELL_PAD_X, y + CELL_PAD_Y + 1, {
                width: col.width - CELL_PAD_X * 2,
                align: col.align === 'left' ? 'left' : col.align,
                lineBreak: false,
            });
            x += col.width;
        }
        doc.y = y + height;
    }

    /** One bordered row; breaks to a new page (repeating the column header) when it won't fit. */
    private drawLine(doc: PDFKit.PDFDocument, line: DeliveryBillLine, index: number, localFonts: Set<string>): void {
        const halfRate = line.taxRate / 2;
        const halfRateText = halfRate.toFixed(halfRate % 1 === 0 ? 0 : 1);
        const hasRate = line.taxRate > 0;
        const hasTax = line.taxAmount > 0;
        const cells = [
            String(index + 1),
            line.name,
            line.hsn,
            String(line.quantity),
            money(line.mrp),
            money(line.rate),
            hasRate ? `CGST ${halfRateText}%\nSGST ${halfRateText}%` : '—',
            hasTax ? `CGST ${money(line.taxAmount / 2)}\nSGST ${money(line.taxAmount / 2)}` : '—',
            money(line.amount),
        ];
        const localFont = line.localName ? localNameFont(line.localName, localFonts) : null;

        const innerWidth = (i: number) => COLUMNS[i].width - CELL_PAD_X * 2;
        const cellHeights = cells.map((text, i) => {
            if (i === ITEM_COLUMN) {
                doc.font('Helvetica-Bold').fontSize(8.5);
                let h = doc.heightOfString(text, { width: innerWidth(i) });
                if (localFont) {
                    doc.font(localFont).fontSize(9.5);
                    h += 1 + doc.heightOfString(line.localName, { width: innerWidth(i) });
                }
                return h;
            }
            if (i === AMOUNT_COLUMN) {
                doc.font('Helvetica-Bold').fontSize(8.5);
                let h = doc.heightOfString(text, { width: innerWidth(i) });
                if (line.save > 0) {
                    doc.font('Helvetica-Oblique').fontSize(8);
                    h += 2 + doc.heightOfString(`save ${money(line.save)}`, { width: innerWidth(i) });
                }
                return h;
            }
            doc.font('Helvetica').fontSize(i >= 6 && i <= 7 ? 8 : 8.5);
            return doc.heightOfString(text, { width: innerWidth(i) });
        });
        const height = Math.max(...cellHeights) + CELL_PAD_Y * 2;
        if (doc.y + height > doc.page.height - MARGIN_Y) {
            doc.addPage();
            this.drawHeaderRow(doc);
        }

        const y = doc.y;
        let x = MARGIN_X;
        cells.forEach((text, i) => {
            const { width, align } = COLUMNS[i];
            doc.lineWidth(0.75).strokeColor(INK).rect(x, y, width, height).stroke();
            const opts = { width: innerWidth(i), align };
            doc.fillColor(INK);
            if (i === ITEM_COLUMN) {
                doc.font('Helvetica-Bold').fontSize(8.5).text(text, x + CELL_PAD_X, y + CELL_PAD_Y, opts);
                if (localFont) {
                    doc.font(localFont).fontSize(9.5).text(line.localName, x + CELL_PAD_X, doc.y + 1, opts);
                }
            } else if (i === AMOUNT_COLUMN) {
                doc.font('Helvetica-Bold').fontSize(8.5).text(text, x + CELL_PAD_X, y + CELL_PAD_Y, opts);
                if (line.save > 0) {
                    doc.font('Helvetica-Oblique').fontSize(8).text(`save ${money(line.save)}`, x + CELL_PAD_X, doc.y + 2, opts);
                }
            } else {
                doc.font(i === 2 ? 'Courier' : 'Helvetica')
                    .fontSize(i >= 6 && i <= 7 ? 8 : 8.5)
                    .text(text, x + CELL_PAD_X, y + CELL_PAD_Y, opts);
            }
            x += width;
        });
        doc.y = y + height;
    }

    /** Notes on the left, totals on the right, then the thank-you line. */
    private drawFooter(doc: PDFKit.PDFDocument, bill: DeliveryBill, seller: WhatsappInvoiceSeller): void {
        const width = contentWidth(doc);
        const totalsWidth = 210;
        const totalsX = MARGIN_X + width - totalsWidth;
        const leftWidth = width - totalsWidth - 12;
        const rows: Array<{ label: string; hint?: string; value: string; kind: 'row' | 'incl' }> = [
            { label: 'Subtotal (incl. GST)', value: money(bill.subtotal), kind: 'row' },
        ];
        if (bill.cgst > 0) {
            rows.push(
                { label: 'Incl. CGST', value: money(bill.cgst), kind: 'incl' },
                { label: 'Incl. SGST', value: money(bill.sgst), kind: 'incl' },
            );
        }
        rows.push({
            label: 'Shipping',
            hint: bill.shippingSaved > 0 ? `(saved ${money(bill.shippingSaved)})` : undefined,
            value: bill.shipping > 0 ? money(bill.shipping) : 'Free',
            kind: 'row',
        });
        for (const discount of bill.discounts) {
            const hints = [discount.code, bill.discountsIncludeShipping ? 'incl. free shipping' : ''].filter(Boolean);
            rows.push({
                label: discount.description,
                hint: hints.join(' ') || undefined,
                value: `-${money(discount.amount)}`,
                kind: 'row',
            });
        }

        // Keep the footer together: start it on a new page if it would split.
        const needed = rows.length * 16 + 60;
        if (doc.y + needed > doc.page.height - MARGIN_Y) {
            doc.addPage();
        }
        const top = doc.y;

        // Left: coupon, loyalty points, item count, savings box.
        doc.y = top + 3;
        const note = (label: string, value: string) => {
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(`${label} `, MARGIN_X, doc.y, {
                width: leftWidth,
                continued: true,
            });
            doc.font('Helvetica').text(value);
        };
        if (bill.couponCodes) {
            note('Coupon:', bill.couponCodes);
        }
        if (bill.loyaltyPointsUsed > 0) {
            note('Loyalty points used:', String(bill.loyaltyPointsUsed));
        }
        note('Total items:', String(bill.totalQuantity));
        if (bill.totalSavings > 0) {
            const text = `You saved ${money(bill.totalSavings)} on this order`;
            doc.font('Helvetica-Bold').fontSize(9);
            const boxY = doc.y + 6;
            const boxWidth = Math.min(leftWidth, doc.widthOfString(text) + 16);
            const boxHeight = doc.heightOfString(text, { width: boxWidth - 16 }) + 10;
            doc.lineWidth(0.75).strokeColor(INK).dash(3, { space: 2 }).rect(MARGIN_X, boxY, boxWidth, boxHeight).stroke().undash();
            doc.fillColor(INK).text(text, MARGIN_X + 8, boxY + 5, { width: boxWidth - 16 });
            doc.y = boxY + boxHeight;
        }
        const leftBottom = doc.y;

        // Right: totals table.
        doc.y = top;
        for (const row of rows) {
            this.totalsRow(doc, totalsX, totalsWidth, row);
        }
        const grandTop = doc.y;
        doc.font('Helvetica-Bold').fontSize(11);
        const grandHeight = 11 + 14;
        this.hRule(doc, totalsX, totalsX + totalsWidth, grandTop, 1.5);
        doc.fillColor(INK).text('NET TOTAL', totalsX + 8, grandTop + 7, { width: totalsWidth * 0.6, lineBreak: false });
        doc.text(money(bill.netTotal), totalsX + 8, grandTop + 7, { width: totalsWidth - 16, align: 'right', lineBreak: false });
        this.hRule(doc, totalsX, totalsX + totalsWidth, grandTop + grandHeight, 1.5);

        doc.y = Math.max(leftBottom, grandTop + grandHeight) + 5;
        doc.lineWidth(0.75).strokeColor(INK).dash(3, { space: 2 });
        doc.moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + width, doc.y).stroke().undash();
        doc.y += 4;
        const thanks =
            bill.rewardPointsAvailable > 0
                ? `Thank you for choosing ${seller.name}! You have ${bill.rewardPointsAvailable} Reward Points in your account. Redeem them on your next purchase and enjoy extra savings.`
                : `Thank you for choosing ${seller.name}!`;
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK).text(thanks, MARGIN_X, doc.y, { width, align: 'center' });
    }

    private totalsRow(
        doc: PDFKit.PDFDocument,
        x: number,
        width: number,
        row: { label: string; hint?: string; value: string; kind: 'row' | 'incl' },
    ): void {
        const incl = row.kind === 'incl';
        const padY = incl ? 1 : 3;
        const labelX = x + (incl ? 16 : 8);
        const labelWidth = width * 0.68 - (incl ? 16 : 8);
        const y = doc.y + padY;
        doc.font(incl ? 'Helvetica-Oblique' : 'Helvetica').fontSize(incl ? 8 : 9).fillColor(INK);
        doc.text(row.label + (row.hint ? ' ' : ''), labelX, y, { width: labelWidth, continued: !!row.hint });
        if (row.hint) {
            doc.font('Helvetica-Oblique').fontSize(8).text(row.hint);
        }
        const labelBottom = doc.y;
        doc.font(incl ? 'Helvetica-Oblique' : 'Helvetica').fontSize(incl ? 8 : 9);
        doc.text(row.value, x + 8, y, { width: width - 16, align: 'right', lineBreak: false });
        doc.y = Math.max(labelBottom, y + doc.currentLineHeight()) + padY;
        if (!incl) {
            this.hRule(doc, x, x + width, doc.y, 0.75);
        }
    }

    private hRule(doc: PDFKit.PDFDocument, x1: number, x2: number, y: number, lineWidth: number): void {
        doc.moveTo(x1, y).lineTo(x2, y).lineWidth(lineWidth).strokeColor(INK).stroke();
    }
}

/** The registered font for a catalogue name, or null when its font is missing (the name is then left out). */
function localNameFont(text: string, registered: Set<string>): string | null {
    // Malayalam has its own Unicode block (U+0D00 to U+0D7F); everything else the catalogue holds is Tamil.
    const name = /[ഀ-ൿ]/.test(text) ? 'malayalam' : 'tamil';
    return registered.has(name) ? name : null;
}

/** Plain rupee number, as on the printed bill. */
function money(paise: number): string {
    return (paise / 100).toFixed(2);
}

function contentWidth(doc: PDFKit.PDFDocument): number {
    return doc.page.width - MARGIN_X * 2;
}
