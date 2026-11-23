import { Injectable } from '@nestjs/common';
import {
    Asset,
    AssetService,
    ConfigService,
    ID,
    InternalServerError,
    Logger,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';

import { loggerCtx } from '../constants';
import { formatPoolQuantity } from './pool-unit.helper';

/**
 * KaaiKani brand logo, resolved for both ts-node and dist. Prefers the
 * PDF-optimized copy (KaaiKani-pdf.png, ~12 KB, crisp at document size) over the
 * full-resolution source (~1.4 MB) so generated PDFs stay small for download.
 */
const LOGO_CANDIDATES = [
    path.join(process.cwd(), 'src', 'assets', 'KaaiKani-pdf.png'),
    path.join(__dirname, '..', '..', '..', '..', 'assets', 'KaaiKani-pdf.png'),
    path.join(process.cwd(), 'dist', 'src', 'assets', 'KaaiKani-pdf.png'),
    path.join(process.cwd(), 'src', 'assets', 'KaaiKani.png'),
    path.join(__dirname, '..', '..', '..', '..', 'assets', 'KaaiKani.png'),
    path.join(process.cwd(), 'dist', 'src', 'assets', 'KaaiKani.png'),
];
function resolveLogo(): string | null {
    for (const p of LOGO_CANDIDATES) {
        try {
            if (fs.existsSync(p)) return p;
        } catch {
            /* ignore */
        }
    }
    return null;
}

/**
 * Dates as they are read at the branch, not as the server happens to hold them.
 *
 * The server runs with TZ=UTC, and a locale is not a time zone: `toLocaleString('en-IN')`
 * gave Indian FORMATTING of a UTC clock, so a transfer confirmed at 10:13 am printed
 * as 04:43 am and the paper disagreed with every screen that showed it. The zone has
 * to be said out loud.
 *
 * Fixed to Asia/Kolkata rather than taken from whoever asked for the document. A PDF
 * is generated once and then printed, filed and carried in a vehicle — it cannot
 * follow the reader, so it needs one answer, and every branch this serves keeps
 * Indian time.
 */
const BRANCH_TIME_ZONE = 'Asia/Kolkata';

const printDate = (d: Date): string => d.toLocaleDateString('en-IN', { timeZone: BRANCH_TIME_ZONE });

const printDateTime = (d: Date): string => d.toLocaleString('en-IN', { timeZone: BRANCH_TIME_ZONE });

export interface TransferPdfLine {
    productName: string;
    sku: string;
    quantityPcs: number | null;
    /** Pool quantity as stored — an integer in the base unit named by poolUnit. */
    weightGrams: number | null;
    /** 'kg', 'litre' or 'piece'. Null on a counted line, or on a legacy row. */
    poolUnit?: string | null;
}

export interface TransferPdfData {
    transferNumber: string;
    documentNumber: string;
    date: Date;
    sourceChannelCode: string;
    destinationChannelCode: string;
    preparedBy: string;
    remarks: string | null;
    driverName?: string | null;
    driverPhone?: string | null;
    vehicleNumber?: string | null;
    lines: TransferPdfLine[];
}

/**
 * Driver and phone as one line, or '' when neither was filled in.
 *
 * Both documents print the pair the same way, and both treat a blank string as
 * absent — a driver named '   ' is not a driver.
 */
const joinDriver = (name?: string | null, phone?: string | null): string =>
    [name, phone]
        .map(s => (s && s.trim() ? s.trim() : ''))
        .filter(Boolean)
        .join(' · ');

/**
 * One consignment on a combined note: the goods for ONE destination, under the
 * transfer number that branch will sign for.
 *
 * A section per TRANSFER rather than per branch, although the two are usually the
 * same thing. A source that ships to Idukki twice in a day has two transfer
 * numbers, two documents and two receipts; printing both under a single "Idukki"
 * heading would show a quantity that cannot be signed for against either number.
 * Sections for the same branch are printed together, so the ordinary case still
 * reads as one branch, one block.
 */
export interface CombinedTransferSection {
    transferNumber: string;
    destinationChannelCode: string;
    remarks: string | null;
    /** Printed on the section only when the loads disagree — see CombinedTransferPdfData. */
    driverName?: string | null;
    driverPhone?: string | null;
    vehicleNumber?: string | null;
    lines: TransferPdfLine[];
}

/**
 * Several transfers leaving one branch on one run, as one piece of paper.
 *
 * The driver carries a single sheet for the whole round instead of a sheaf to sort
 * at each stop. Nothing about the transfers themselves changes: each keeps its own
 * number, its own stored document and its own receipt, and this is only another way
 * of printing what they already say. Which is why this builder stores nothing — the
 * per-transfer document remains the record, and a trip sheet is a convenience
 * reprinted whenever it is wanted.
 *
 * Driver and vehicle sit in the head when every section names the same ones, which
 * is what one run means. When they disagree the head cannot honestly claim either,
 * so they drop to the sections rather than the head quietly printing the first.
 */
export interface CombinedTransferPdfData {
    date: Date;
    sourceChannelCode: string;
    /** Null when the sections disagree; each section then prints its own. */
    driverName: string | null;
    driverPhone: string | null;
    vehicleNumber: string | null;
    sections: CombinedTransferSection[];
}

export interface DamagePdfLine {
    productName: string;
    sku: string;
    damagedPcs: number | null;
    /** Damaged pool quantity as stored — base units, per poolUnit. */
    damagedGrams: number | null;
    /** 'kg', 'litre' or 'piece'. Null on a counted line, or on a legacy row. */
    poolUnit?: string | null;
    damagePercent: string;
    note: string | null;
    photoCount: number;
}

export interface DamagePdfData {
    documentNumber: string;
    date: Date;
    transferNumber: string;
    remarks: string | null;
    requestedBy: string;
    approvedBy: string;
    lines: DamagePdfLine[];
}

/**
 * Transfer PDF builder + storage (TDS §18, BRS §10).
 *
 * - pdfkit: already a project dependency (zero new deps).
 * - Content: number, date, source→destination, lines with Weight/PCS, prepared-by.
 *   NO price (Q3b hold), NO barcode, NO vehicle/driver (BRS §12).
 * - Stored via core AssetService → existing S3 bucket + authenticated /assets
 *   route → permanent & re-downloadable (PDF History report, Step 7).
 * - Generated INSIDE the confirming transaction: PDF failure rolls the whole
 *   confirm back cleanly (no CONFIRMED state without its document).
 */
@Injectable()
export class TransferPdfService {
    constructor(
        private assetService: AssetService,
        private connection: TransactionalConnection,
        private configService: ConfigService,
    ) {}

    /**
     * A transfer has ONE document for its whole life. The first confirm creates it;
     * a revert → edit → re-confirm rewrites the SAME file, so pdfAssetId never
     * changes and the driver's copy is always reprintable from one place — no
     * superseded copies accumulate and no asset id is wasted.
     *
     * Pass the transfer's current pdfAssetId to rewrite; omit it to create.
     */
    async generateAndStoreTransferPdf(
        ctx: RequestContext,
        data: TransferPdfData,
        existingAssetId?: ID | null,
    ): Promise<Asset> {
        const buffer = await this.buildTransferPdf(data);
        if (existingAssetId) {
            const rewritten = await this.rewriteAssetSource(ctx, existingAssetId, buffer);
            if (rewritten) {
                return rewritten;
            }
            // The asset was removed outside this module — fall through and make a new one.
        }
        return this.storeAsAsset(ctx, buffer, `${data.documentNumber.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`);
    }

    /**
     * Replace an existing asset's file in place, keeping its id, name and URL.
     * Only `source` is rewritten — `preview` is a generated PDF icon, not the
     * document, so it stays valid.
     *
     * The file write lands outside the surrounding DB transaction. If that
     * transaction later rolls back, the stored document is the newer one while the
     * transfer keeps its older state; the next confirm rewrites it, and a document
     * that is one edit ahead is a far smaller problem than a pile of orphans.
     */
    private async rewriteAssetSource(ctx: RequestContext, assetId: ID, buffer: Buffer): Promise<Asset | null> {
        const repo = this.connection.getRepository(ctx, Asset);
        const asset = await repo.findOne({ where: { id: assetId as any } });
        if (!asset?.source) {
            return null;
        }
        try {
            await this.configService.assetOptions.assetStorageStrategy.writeFileFromBuffer(asset.source, buffer);
        } catch (err: any) {
            Logger.warn(
                `Could not rewrite transfer document (asset ${assetId}): ${err.message} — issuing a new one`,
                loggerCtx,
            );
            return null;
        }
        asset.fileSize = buffer.length;
        return repo.save(asset);
    }

    async generateAndStoreDamagePdf(ctx: RequestContext, data: DamagePdfData): Promise<Asset> {
        const buffer = await this.buildDamagePdf(data);
        return this.storeAsAsset(ctx, buffer, `${data.documentNumber.replace(/[^A-Za-z0-9-]/g, '_')}.pdf`);
    }

    /**
     * Damage document: linked transfer, then one row per damaged product with its
     * quantity, percentage, photo count and note. A request covers everything the
     * branch found in one transfer, so the document is a table, not a single item.
     */
    buildDamagePdf(data: DamagePdfData): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 40 });
            const chunks: Buffer[] = [];
            doc.on('data', c => chunks.push(c as Buffer));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            doc.fontSize(16).text('KAAIKANI — DAMAGE RETURN', { align: 'center' });
            doc.moveDown(0.3);
            doc.fontSize(10).text(`Document No: ${data.documentNumber}    Date: ${printDate(data.date)}`, {
                align: 'center',
            });
            doc.text(`Linked Transfer: ${data.transferNumber}`, { align: 'center' });
            doc.moveDown(1);

            const x = doc.page.margins.left;
            const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const cols = [28, 200, 100, 60, 50]; // #, product, damaged, %, photos

            const row = (cells: string[], bold: boolean) => {
                const y = doc.y;
                let cx = x;
                doc.fontSize(bold ? 10 : 9);
                cells.forEach((cell, i) => {
                    doc.text(cell, cx + 3, y + 4, { width: cols[i] - 6, ellipsis: true });
                    cx += cols[i];
                });
                doc.rect(x, y, width, 18).stroke();
                doc.y = y + 18;
            };

            row(['#', 'Product', 'Damaged', '%', 'Photos'], true);
            data.lines.forEach((l, i) => {
                const qty =
                    l.damagedGrams != null
                        ? formatPoolQuantity(l.damagedGrams, l.poolUnit)
                        : `${l.damagedPcs} pcs`;
                row([String(i + 1), l.productName, qty, `${l.damagePercent}%`, String(l.photoCount)], false);
            });

            // Notes are optional and usually rare — list only the ones that exist,
            // rather than padding the table with empty cells.
            const noted = data.lines.filter(l => l.note && l.note.trim());
            if (noted.length) {
                doc.moveDown(0.8).fontSize(10).text('Notes:', x);
                noted.forEach(l => doc.fontSize(9).text(`• ${l.productName}: ${l.note}`, x));
            }

            doc.moveDown(0.8).fontSize(10);
            doc.text(`Total damaged products: ${data.lines.length}`, x);
            doc.text(`Remarks: ${data.remarks || '—'}`, x);
            doc.text(`Requested by: ${data.requestedBy}`, x);
            doc.text(`Approved by: ${data.approvedBy}`, x);
            doc.moveDown(0.8);
            doc.fontSize(9).text('Stock has been deducted from the destination branch upon this approval.', x);
            doc.end();
        });
    }

    /**
     * The drawing primitives both transfer documents share.
     *
     * A combined note is the same paper as a single one — same masthead, same ruled
     * table, same row heights — carrying several consignments instead of one. Keeping
     * the geometry and the three drawing routines in one place is what keeps that
     * true: a column widened for one is widened for both, and a driver never ends up
     * holding two sheets that look like they came from different companies.
     *
     * Returned as closures over `doc` rather than taking it as a parameter each time,
     * because every one of them writes to that document and none of them is meaningful
     * without it.
     */
    private layout(doc: PDFKit.PDFDocument) {
        const L = doc.page.margins.left;
        const R = doc.page.width - doc.page.margins.right;
        const W = R - L;
        const BOTTOM = doc.page.height - doc.page.margins.bottom;

        const INK = '#000000';
        const MUTE = '#555555';
        const RULE = '#000000';
        const HEAD_FILL = '#eeeeec';

        // Column offsets from the left margin: # · description · sku · qty.
        //
        // The unit travels inside the quantity ("10.000 kg", "23 pcs") rather
        // than in a column of its own. A column holding nothing but "kg" or
        // "pcs" spends width on repetition, and splitting a measurement from its
        // unit makes the reader join them back together to read a single value.
        const COL = { no: 0, item: 28, sku: W - 200, qty: W - 105 };
        const COL_W = { no: 28, item: W - 228, sku: 95, qty: 105 };
        const ROW_MIN = 25;

        /** Room the closing block needs, so a table never runs into it. */
        const TAIL = 90;

        /**
         * The centred masthead, drawn identically on every page.
         *
         * A continuation sheet is a page of a document, not a lesser thing: found
         * on its own it still has to say who sent it. Making page two look like
         * page one costs a few centimetres and saves that question.
         */
        const masthead = (): number => {
            const logo = resolveLogo();
            let yy = 40;
            if (logo) {
                try {
                    // The mark is roughly 3.8:1, so width alone sets the size.
                    doc.image(logo, L + W / 2 - 65, yy, { width: 130 });
                    yy += 42;
                } catch {
                    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
                        .text('KaaiKani', L, yy, { width: W, align: 'center' });
                    yy += 30;
                }
            } else {
                doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
                    .text('KaaiKani', L, yy, { width: W, align: 'center' });
                yy += 30;
            }
            doc.font('Helvetica').fontSize(9).fillColor(MUTE)
                .text('Kovil Papakudi, Madurai-625018', L, yy, { width: W, align: 'center' })
                .text('Toll Free: 1800 309 4983', L, yy + 12, { width: W, align: 'center' });
            return yy + 34;
        };

        /** Table header row, repeated at the top of every page. */
        const tableHeader = (y: number): number => {
            const h = 26;
            doc.save().rect(L, y, W, h).fillAndStroke(HEAD_FILL, RULE).restore();
            doc.lineWidth(1).strokeColor(RULE).rect(L, y, W, h).stroke();
            doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK);
            doc.text('#', L + COL.no + 6, y + 8, { width: COL_W.no - 8 });
            doc.text('ITEM DESCRIPTION', L + COL.item + 6, y + 8, { width: COL_W.item - 10 });
            doc.text('SKU', L + COL.sku + 6, y + 8, { width: COL_W.sku - 10 });
            doc.text('QTY', L + COL.qty, y + 8, { width: COL_W.qty - 8, align: 'right' });
            for (const x of [COL.item, COL.sku, COL.qty]) {
                doc.moveTo(L + x, y).lineTo(L + x, y + h).stroke();
            }
            return y + h;
        };

        /**
         * One ruled item row, returning the y it ended at.
         *
         * The row number is PASSED rather than counted here. A combined note numbers
         * each consignment from 1, because each is the list a branch signs for, and a
         * row has no way of knowing which document it belongs to.
         *
         * `breakPage` is what to draw when this row will not fit — a new page, its
         * masthead, and whatever heading the caller's document repeats on a
         * continuation sheet — returning the y to carry on from. Checked BEFORE the
         * row is drawn rather than after, so a page never ends mid-table.
         */
        const itemRow = (
            y: number,
            n: number,
            line: TransferPdfLine,
            breakPage: () => number,
        ): number => {
            const pooled = line.weightGrams != null;
            // The measurement and its unit stay together — "10.000 kg" is one
            // value, and reading it should not mean looking in two places.
            //
            // The unit comes from the line, because a pool is not always a weight:
            // this printed "30.000 kg" for thirty lemons until the unit was carried
            // here, and the branch loading the vehicle read it off the paper.
            const qtyText = pooled
                ? formatPoolQuantity(line.weightGrams as number, line.poolUnit)
                : line.quantityPcs != null
                  ? `${line.quantityPcs} pcs`
                  : '-';

            doc.font('Helvetica-Bold').fontSize(12);
            const nameH = doc.heightOfString(line.productName, { width: COL_W.item - 10 });
            const rowH = Math.max(ROW_MIN, nameH + 11);

            if (y + rowH > BOTTOM - TAIL) {
                y = breakPage();
            }

            doc.lineWidth(0.8).strokeColor(RULE).rect(L, y, W, rowH).stroke();
            for (const x of [COL.item, COL.sku, COL.qty]) {
                doc.moveTo(L + x, y).lineTo(L + x, y + rowH).stroke();
            }
            doc.font('Helvetica').fontSize(10).fillColor(INK)
                .text(String(n), L + COL.no + 6, y + 6, { width: COL_W.no - 8 });
            doc.font('Helvetica-Bold').fontSize(12)
                .text(line.productName, L + COL.item + 6, y + 5, { width: COL_W.item - 10 });
            doc.font('Helvetica').fontSize(10.5)
                .text(line.sku || '-', L + COL.sku + 6, y + 6, { width: COL_W.sku - 10, ellipsis: true, lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(12)
                .text(qtyText, L + COL.qty, y + 5, { width: COL_W.qty - 8, align: 'right' });
            return y + rowH;
        };

        /**
         * Page numbers, stamped once the total is known.
         *
         * Written last for that reason: page one cannot say "1 / 3" until the
         * third page exists. The bottom margin is lifted while stamping, because
         * pdfkit would otherwise treat text at the foot of the page as an
         * overflow and helpfully add another page — which would then need a
         * number of its own.
         */
        const stampPageNumbers = (): void => {
            const range = doc.bufferedPageRange();
            for (let i = 0; i < range.count; i++) {
                doc.switchToPage(range.start + i);
                const keep = doc.page.margins.bottom;
                doc.page.margins.bottom = 0;
                doc.font('Helvetica').fontSize(8.5).fillColor(MUTE).text(
                    `${i + 1} / ${range.count}`,
                    L,
                    doc.page.height - keep + 6,
                    { width: W, align: 'right', lineBreak: false },
                );
                doc.page.margins.bottom = keep;
            }
            doc.flushPages();
        };

        /**
         * The ruled block under the masthead: labelled details on the left, the two
         * branches on the right.
         *
         * The values line up in a column of their own, measured rather than guessed.
         *
         * Every value used to start a flat 62pt from the label's left edge, and
         * "TRANSFER NO:" is very nearly 62pt wide — so its value sat hard against
         * the colon while "DATE:" left a gap three times larger. Four rows, four
         * different starts, nothing for the eye to run down.
         *
         * Measuring the WIDEST label makes the column follow the labels: reword one
         * and the values move with it, rather than the longest quietly colliding
         * with its colon again.
         */
        const documentBlock = (
            y: number,
            fields: Array<[string, string]>,
            shipFrom: string,
            shipTo: string,
        ): number => {
            const blockH = 62;
            const mid = L + W * 0.56;
            doc.lineWidth(1.1).strokeColor(RULE).rect(L, y, W, blockH).stroke();
            doc.moveTo(mid, y).lineTo(mid, y + blockH).stroke();

            doc.font('Helvetica-Bold').fontSize(8);
            const labelW = Math.max(...fields.map(([label]) => doc.widthOfString(label))) + 10;
            const vx = L + 10 + labelW;
            fields.forEach(([label, value], i) => {
                const yy = y + 9 + i * 13;
                doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(label, L + 10, yy);
                doc.font('Helvetica').fontSize(8.5).fillColor(INK)
                    .text(value, vx, yy, { width: mid - vx - 10, ellipsis: true, lineBreak: false });
            });

            const rx = mid + 10;
            const rw = R - rx - 10;
            doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTE).text('SHIP FROM', rx, y + 8);
            doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
                .text(shipFrom, rx, y + 18, { width: rw, ellipsis: true, lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTE).text('SHIP TO', rx, y + 34);
            doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
                .text(shipTo, rx, y + 44, { width: rw, ellipsis: true, lineBreak: false });

            return y + blockH + 12;
        };

        return {
            L, R, W, BOTTOM, TAIL, INK, MUTE, RULE, HEAD_FILL, ROW_MIN,
            masthead, tableHeader, itemRow, stampPageNumbers, documentBlock,
        };
    }

    /**
     * The transfer document, built to the same skeleton as the bill print already in
     * use: centred logo and address, one ruled block carrying the document details
     * and the two branches, a fully ruled item table, then a closing totals block.
     *
     * The columns differ from a bill because a transfer carries no price — no MRP,
     * no rate, no tax, no GST. What matters instead is the unit: weighed goods are
     * counted in kilograms and everything else in pieces, and the two must never be
     * added together, which is why the totals keep them apart.
     *
     * Long transfers run onto further pages; the table header is repeated on each so
     * a page found on its own still reads.
     */
    buildTransferPdf(data: TransferPdfData): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            // bufferPages so the footer can stamp "n / total" once the total is known.
            const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
            const chunks: Buffer[] = [];
            doc.on('data', c => chunks.push(c as Buffer));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const { L, R, INK, W, masthead, tableHeader, itemRow, stampPageNumbers, documentBlock } =
                this.layout(doc);

            let y = masthead();
            y = documentBlock(
                y,
                [
                    ['TRANSFER NO:', data.transferNumber],
                    ['DATE:', printDateTime(data.date)],
                    ['VEHICLE:', data.vehicleNumber?.trim() || '-'],
                    ['DRIVER:', joinDriver(data.driverName, data.driverPhone) || '-'],
                ],
                data.sourceChannelCode,
                data.destinationChannelCode,
            );
            y = tableHeader(y);

            // ---- item rows
            data.lines.forEach((line, i) => {
                y = itemRow(y, i + 1, line, () => {
                    doc.addPage();
                    return tableHeader(masthead());
                });
            });

            /*
             * ---- the closing figure: one total, on the left, standing on its own
             *
             * There were three — "Total pieces", "Total weight" and "TOTAL ITEMS" —
             * boxed and ruled against the right margin, where they read as a second
             * little table hanging off the first. Two of them counted things the paper
             * was not being asked for: the quantities are already in the column above,
             * line by line, in the unit each is measured in.
             *
             * What is left is the one figure that cannot be read off the rows at a
             * glance. It sits under the table on the left with room around it, so it
             * belongs to the document rather than to the table, and it keeps the weight
             * the boxed row had — it is the closing number of the note, not a footnote
             * to the rows.
             */
            let ty = y + 14;
            doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
                .text(`TOTAL ITEMS: ${data.lines.length}`, L, ty);
            ty = doc.y + 12;

            /*
             * ---- footer
             *
             * The disclaimer that used to close the page — "Goods listed above are
             * transferred between branches. No sale value — this document is not an
             * invoice." — has gone, along with the "Prepared by" line beneath it.
             * Nobody read either. The note says TRANSFER NO at the head and carries no
             * prices anywhere, so it cannot be taken for an invoice by anyone holding
             * it; and who prepared it is on every screen that shows the transfer, and
             * in the audit trail, which is where the question would be asked.
             */
            if (data.remarks?.trim()) {
                doc.font('Helvetica').fontSize(8.5).fillColor(INK)
                    .text(`Remarks: ${data.remarks.trim()}`, L, ty, { width: W });
                ty = doc.y + 6;
            }
            doc.dash(2, { space: 2 }).lineWidth(0.8).strokeColor('#444444')
                .moveTo(L, ty).lineTo(R, ty).stroke().undash();

            stampPageNumbers();
            doc.end();
        });
    }

    /**
     * One run, one sheet: several transfers leaving the same branch, printed together.
     *
     * Nothing is stored and nothing is changed. Each transfer keeps its own permanent
     * document, its own number and its own receipt; this is a second way of printing
     * what they already say, for the driver who is making all the drops in one trip.
     *
     * Each consignment gets its own heading, its own table and its own item count,
     * because each is signed for separately at a different door. The head carries what
     * the whole run has in common — where it left from, when, and the driver and
     * vehicle when every consignment names the same ones.
     */
    buildCombinedTransferPdf(data: CombinedTransferPdfData): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 36, bufferPages: true });
            const chunks: Buffer[] = [];
            doc.on('data', c => chunks.push(c as Buffer));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const {
                L, R, W, BOTTOM, TAIL, INK, MUTE, RULE, ROW_MIN,
                masthead, tableHeader, itemRow, stampPageNumbers, documentBlock,
            } = this.layout(doc);

            const headDriver = joinDriver(data.driverName, data.driverPhone);
            const headVehicle = data.vehicleNumber?.trim() ?? '';
            /** Said once when the run agrees, and per consignment when it does not. */
            const SPLIT = 'see each consignment';

            // Branches in the order their first consignment appears, listed once each:
            // two loads to Idukki make one entry in the head, and two sections below.
            const branches = [...new Set(data.sections.map(s => s.destinationChannelCode))];

            let y = masthead();
            y = documentBlock(
                y,
                [
                    ['DATE:', printDateTime(data.date)],
                    ['VEHICLE:', headVehicle || (data.sections.length > 1 ? SPLIT : '-')],
                    ['DRIVER:', headDriver || (data.sections.length > 1 ? SPLIT : '-')],
                    [
                        'CONSIGNMENTS:',
                        `${data.sections.length} to ${branches.length} ${branches.length === 1 ? 'branch' : 'branches'}`,
                    ],
                ],
                data.sourceChannelCode,
                branches.join(', '),
            );

            const HEAD_H = 24;

            /**
             * The bar naming whose goods the table below belongs to.
             *
             * Repeated with "(contd.)" at the top of a continuation page for the same
             * reason the masthead is: a sheet that carries on a table has to say which
             * branch it is listing, or the rows on it belong to nobody.
             */
            const sectionHeading = (yy: number, section: CombinedTransferSection, contd = false): number => {
                doc.save().rect(L, yy, W, HEAD_H).fillAndStroke('#f6f6f4', RULE).restore();
                doc.lineWidth(1).strokeColor(RULE).rect(L, yy, W, HEAD_H).stroke();
                doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(
                    `SHIP TO: ${section.destinationChannelCode}${contd ? '  (contd.)' : ''}`,
                    L + 8,
                    yy + 7,
                    { width: W * 0.55 - 8, ellipsis: true, lineBreak: false },
                );
                doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(
                    section.transferNumber,
                    L + W * 0.55,
                    yy + 7,
                    { width: W * 0.45 - 8, align: 'right', ellipsis: true, lineBreak: false },
                );
                return yy + HEAD_H;
            };

            let totalItems = 0;

            data.sections.forEach(section => {
                /*
                  A heading alone at the foot of a page is worse than the break it
                  avoided: the reader turns over looking for the branch's goods and
                  finds another table header. The heading, its columns and its first
                  row travel together.
                */
                if (y + HEAD_H + 26 + ROW_MIN > BOTTOM - TAIL) {
                    doc.addPage();
                    y = masthead();
                }

                y = sectionHeading(y, section);

                // Only when the head could not say it for the whole run.
                if (!headDriver || !headVehicle) {
                    const own = [
                        !headVehicle ? section.vehicleNumber?.trim() : '',
                        !headDriver ? joinDriver(section.driverName, section.driverPhone) : '',
                    ]
                        .filter(Boolean)
                        .join(' · ');
                    if (own) {
                        doc.font('Helvetica').fontSize(8.5).fillColor(MUTE)
                            .text(own, L + 8, y + 4, { width: W - 16, ellipsis: true, lineBreak: false });
                        y += 16;
                    }
                }

                y = tableHeader(y);
                section.lines.forEach((line, i) => {
                    y = itemRow(y, i + 1, line, () => {
                        doc.addPage();
                        return tableHeader(sectionHeading(masthead(), section, true));
                    });
                });
                totalItems += section.lines.length;

                doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(
                    `${section.destinationChannelCode} items: ${section.lines.length}`,
                    L,
                    y + 6,
                    { width: W, align: 'right' },
                );
                y = doc.y + 6;

                if (section.remarks?.trim()) {
                    doc.font('Helvetica').fontSize(8.5).fillColor(INK)
                        .text(`Remarks: ${section.remarks.trim()}`, L, y, { width: W });
                    y = doc.y + 4;
                }
                y += 10;
            });

            // The closing figure needs a page of its own rather than being squeezed
            // under the last section — the same rule the rows follow.
            if (y + 40 > BOTTOM) {
                doc.addPage();
                y = masthead();
            }

            let ty = y + 4;
            doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
                .text(`TOTAL ITEMS: ${totalItems}`, L, ty);
            ty = doc.y + 12;
            doc.dash(2, { space: 2 }).lineWidth(0.8).strokeColor('#444444')
                .moveTo(L, ty).lineTo(R, ty).stroke().undash();

            stampPageNumbers();
            doc.end();
        });
    }

    /** Store via core AssetService (existing S3) — permanent, re-downloadable. */
    private async storeAsAsset(ctx: RequestContext, buffer: Buffer, fileName: string): Promise<Asset> {
        const stream = Readable.from(buffer);
        // Signature: createFromFileStream(stream, filePath, ctx) — filePath drives
        // the asset name AND the mime-type detection (.pdf).
        const result = await this.assetService.createFromFileStream(stream, fileName, ctx);
        if (result instanceof Asset) {
            return result;
        }
        // MimeTypeError or similar — must fail the surrounding transaction.
        throw new InternalServerError(`Could not store transfer PDF: ${(result as any)?.message ?? 'unknown error'}`);
    }
}
