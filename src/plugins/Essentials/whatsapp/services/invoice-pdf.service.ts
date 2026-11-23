import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';

import { InvoiceLine, InvoiceSummary } from '../functions/invoice-summary';
import { WhatsappInvoiceSeller } from '../types';

const MARGIN = 36;
const INK = '#111827';
const MUTE = '#4b5563';
const RULE = '#9ca3af';
const HEADER_FILL = '#f3f4f6';
const SAVE = '#15803d';
const CELL_PAD = 4;

interface Column {
    title: string;
    width: number;
    align: 'left' | 'center' | 'right';
    cell: (line: InvoiceLine, index: number) => string;
}

// Widths sum to the A4 content width (595 − 2 × MARGIN = 523).
const COLUMNS: Column[] = [
    { title: '#', width: 18, align: 'center', cell: (_, i) => String(i + 1) },
    { title: 'ITEM DESCRIPTION', width: 150, align: 'left', cell: line => line.name },
    { title: 'HSN', width: 45, align: 'center', cell: line => line.hsn },
    { title: 'QTY', width: 30, align: 'center', cell: line => String(line.quantity) },
    { title: 'MRP', width: 48, align: 'right', cell: line => money(line.mrp) },
    { title: 'RATE', width: 48, align: 'right', cell: line => money(line.rate) },
    {
        title: 'TAX',
        width: 60,
        align: 'center',
        cell: line => (line.taxRate ? `CGST ${half(line.taxRate)}%\nSGST ${half(line.taxRate)}%` : '—'),
    },
    {
        title: 'GST',
        width: 60,
        align: 'center',
        cell: line => (line.taxRate ? `${money(line.cgst)}\n${money(line.sgst)}` : '—'),
    },
    { title: 'AMOUNT', width: 64, align: 'right', cell: line => money(line.amount) },
];

/**
 * Renders the customer invoice PDF sent with the WhatsApp order confirmation.
 * Same content and layout as the storefront's downloadable invoice, which is a
 * browser screenshot and so cannot be produced on the server — hence pdfkit,
 * as the goods-transfer documents do (no headless browser needed).
 */
@Injectable()
export class InvoicePdfService {
    render(invoice: InvoiceSummary, seller: WhatsappInvoiceSeller): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Invoice ${invoice.invoiceNo}` } });
            const chunks: Buffer[] = [];
            doc.on('data', chunk => chunks.push(chunk as Buffer));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);
            try {
                this.drawHeader(doc, seller);
                this.drawMeta(doc, invoice);
                this.drawItems(doc, invoice.lines);
                this.drawTotals(doc, invoice, seller);
                doc.end();
            } catch (err) {
                reject(err);
            }
        });
    }

    private drawHeader(doc: PDFKit.PDFDocument, seller: WhatsappInvoiceSeller): void {
        const top = doc.y;
        let textX = MARGIN;
        const logoPath = resolveAsset(seller.logoFile);
        if (logoPath) {
            doc.image(logoPath, MARGIN, top, { width: 56 });
            textX += 66;
        }
        doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(seller.name, textX, top + 4);
        doc.font('Helvetica').fontSize(9).fillColor(MUTE).text(seller.headOffice, textX);
        doc.text(`Phone: ${seller.phones.join(', ')}`, textX);
        doc.y = Math.max(doc.y, top + 56) + 10;
        this.rule(doc);
    }

    private drawMeta(doc: PDFKit.PDFDocument, invoice: InvoiceSummary): void {
        const top = doc.y + 8;
        const colWidth = contentWidth(doc) / 2 - 8;
        const left = [
            ['INVOICE NO:', invoice.invoiceNo],
            ['DATE:', invoice.dateTime],
            ['PAYMENT:', invoice.payment],
            ['ORDER:', invoice.orderCode],
            ...(invoice.deliveryName ? [[invoice.isTakeaway ? 'TAKEAWAY:' : 'DELIVERY:', invoice.deliveryName]] : []),
        ];
        doc.y = top;
        for (const [label, value] of left) {
            doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(`${label} `, MARGIN, doc.y, {
                width: colWidth,
                continued: true,
            });
            doc.font('Helvetica').text(value);
        }
        const leftBottom = doc.y;

        const rightX = MARGIN + colWidth + 16;
        doc.font('Helvetica-Bold').fontSize(9).text('BILL TO', rightX, top, { width: colWidth });
        doc.text(invoice.billName + (invoice.billPhone ? ` · ${invoice.billPhone}` : ''), rightX, doc.y, {
            width: colWidth,
        });
        if (invoice.billAddress) {
            doc.font('Helvetica').fillColor(MUTE).text(invoice.billAddress, rightX, doc.y, { width: colWidth });
        }
        doc.y = Math.max(leftBottom, doc.y) + 12;
    }

    private drawItems(doc: PDFKit.PDFDocument, lines: InvoiceLine[]): void {
        this.drawRow(doc, COLUMNS.map(col => col.title), { header: true });
        lines.forEach((line, index) => {
            const cells = COLUMNS.map(col => col.cell(line, index));
            if (line.save > 0) {
                cells[cells.length - 1] += `\nsave ${money(line.save)}`;
            }
            this.drawRow(doc, cells, { header: false });
        });
        doc.y += 10;
    }

    /** One bordered table row; breaks to a new page (and repeats the header) when it won't fit. */
    private drawRow(doc: PDFKit.PDFDocument, cells: string[], { header }: { header: boolean }): void {
        doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 8 : 8.5);
        const height =
            Math.max(...cells.map((text, i) => doc.heightOfString(text, { width: COLUMNS[i].width - CELL_PAD * 2 }))) +
            CELL_PAD * 2;
        if (doc.y + height > doc.page.height - MARGIN) {
            doc.addPage();
            if (!header) {
                this.drawRow(doc, COLUMNS.map(col => col.title), { header: true });
                doc.font('Helvetica').fontSize(8.5);
            }
        }
        const y = doc.y;
        let x = MARGIN;
        cells.forEach((text, i) => {
            const { width, align } = COLUMNS[i];
            if (header) {
                doc.rect(x, y, width, height).fill(HEADER_FILL);
            }
            doc.rect(x, y, width, height).lineWidth(0.5).strokeColor(RULE).stroke();
            doc.fillColor(INK).text(text, x + CELL_PAD, y + CELL_PAD, { width: width - CELL_PAD * 2, align });
            x += width;
        });
        doc.y = y + height;
    }

    private drawTotals(doc: PDFKit.PDFDocument, invoice: InvoiceSummary, seller: WhatsappInvoiceSeller): void {
        const top = doc.y;
        const summaryWidth = contentWidth(doc) / 2 - 8;
        doc.font('Helvetica').fontSize(9).fillColor(INK);
        if (invoice.couponCodes.length) {
            doc.text(`Coupon: ${invoice.couponCodes.join(', ')}`, MARGIN, doc.y, { width: summaryWidth });
        }
        if (invoice.loyaltyPointsUsed > 0) {
            doc.text(`Loyalty points used: ${invoice.loyaltyPointsUsed}`, MARGIN, doc.y, { width: summaryWidth });
        }
        doc.text(`Total items: ${invoice.totalQuantity}`, MARGIN, doc.y, { width: summaryWidth });
        if (invoice.totalSavings > 0) {
            doc.font('Helvetica-Bold')
                .fillColor(SAVE)
                .text(`You saved ${money(invoice.totalSavings)} on this order`, MARGIN, doc.y, {
                    width: summaryWidth,
                });
        }
        const summaryBottom = doc.y;

        const rows: Array<[string, string]> = [['Subtotal (incl. GST)', money(invoice.subtotal)]];
        if (invoice.cgst + invoice.sgst > 0) {
            rows.push(['Includes CGST', money(invoice.cgst)], ['Includes SGST', money(invoice.sgst)]);
        }
        rows.push(['Shipping', money(invoice.originalShipping)]);
        if (invoice.freeDelivery > 0) {
            rows.push(['Free Delivery', `-${money(invoice.freeDelivery)}`]);
        }
        if (invoice.couponDiscount > 0) {
            rows.push([invoice.couponLabel, `-${money(invoice.couponDiscount)}`]);
        }
        if (invoice.loyaltyDiscount > 0) {
            rows.push(['Loyalty Points Discount', `-${money(invoice.loyaltyDiscount)}`]);
        }
        const totalsX = MARGIN + summaryWidth + 16;
        doc.y = top;
        for (const [label, value] of rows) {
            this.totalsRow(doc, totalsX, summaryWidth, label, value, false);
        }
        doc.moveTo(totalsX, doc.y + 2).lineTo(totalsX + summaryWidth, doc.y + 2).strokeColor(RULE).stroke();
        doc.y += 6;
        this.totalsRow(doc, totalsX, summaryWidth, 'NET TOTAL', money(invoice.netTotal), true);

        doc.y = Math.max(summaryBottom, doc.y) + 18;
        doc.font('Helvetica').fontSize(9).fillColor(MUTE).text(`Thank you for choosing ${seller.name}!`, MARGIN, doc.y, {
            width: contentWidth(doc),
            align: 'center',
        });
    }

    private totalsRow(
        doc: PDFKit.PDFDocument,
        x: number,
        width: number,
        label: string,
        value: string,
        bold: boolean,
    ): void {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(INK);
        doc.text(label, x, y, { width: width * 0.65 });
        const labelBottom = doc.y;
        doc.text(value, x, y, { width, align: 'right' });
        doc.y = Math.max(labelBottom, doc.y) + 2;
    }

    private rule(doc: PDFKit.PDFDocument): void {
        doc.moveTo(MARGIN, doc.y).lineTo(doc.page.width - MARGIN, doc.y).lineWidth(0.5).strokeColor(RULE).stroke();
    }
}

/** Plain rupee number, as on the storefront invoice (Helvetica has no ₹ glyph). */
function money(paise: number): string {
    return (paise / 100).toFixed(2);
}

function half(rate: number): number {
    return Number((rate / 2).toFixed(2));
}

function contentWidth(doc: PDFKit.PDFDocument): number {
    return doc.page.width - MARGIN * 2;
}

/**
 * A file under src/assets (a logo, a font): src/assets under ts-node,
 * dist/src/assets after `bun run build` (the copy script puts it there).
 */
export function resolveAsset(file: string): string | null {
    const candidates = [
        path.join(process.cwd(), 'src', 'assets', file),
        path.join(process.cwd(), 'dist', 'src', 'assets', file),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}
