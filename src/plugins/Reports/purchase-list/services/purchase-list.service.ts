import { Injectable } from '@nestjs/common';
import {
    ID,
    LanguageCode,
    Logger,
    ProductVariant,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';
import { In, IsNull } from 'typeorm';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EMPTY_MEASURE } from '../../../Stock/shared/measurement';
import { resolveVariantMeasures } from '../../../Stock/shared/resolve-variant-measure';
import {
    buildPurchaseReportRows,
    PurchaseLineInput,
    PurchaseReportRow,
} from '../build-purchase-report-rows';
import {
    buildPurchaseListDocument,
    formatHeaderDate,
    toPrintRows,
} from '../purchase-list-document';
import { PurchaseListPdfService } from './purchase-list-pdf.service';

const loggerCtx = 'PurchaseListReport';

/** Chunk size for IN () lookups -- MySQL chokes on unbounded lists. */
const ID_CHUNK_SIZE = 500;

export interface PurchaseListReportInput {
    from: Date;
    to: Date;
    /** Omit to use the caller's active channel. NEVER pass __default_channel__. */
    channelIds?: ID[];
    /** Order states to include. Defaults to the outstanding-orders set. */
    states?: string[];
}

export interface PurchaseListReport {
    rows: PurchaseReportRow[];
    /** Distinct orders behind the numbers -- the "aggregated from N orders" line. */
    orderCount: number;
    /** Order lines read. Useful for spotting a silent truncation. */
    lineCount: number;
    /** Rows where some of the quantity is an assumption rather than a measurement. */
    incompleteCount: number;
}

/**
 * The Purchase List, computed from the catalogue rather than a spreadsheet.
 *
 *   OrdNo              FacetValue.customFields.purchaseOrdNo (lowest wins)
 *   Item Name          localName of the product, or of the variant when the row
 *                      is variant-scoped (see build-purchase-report-rows)
 *   Qty / Pcs          Σ (variant measurement x ordered quantity)
 *
 * WHY THIS EXISTS AS A SERVICE AND NOT IN THE DASHBOARD
 * -----------------------------------------------------
 * The original lives in the delivery dashboard's React component, which is why
 * the report could never be scheduled: the logic was only reachable from a
 * browser. Everything here is callable in-process by the worker, so the same
 * numbers can be printed on screen and mailed to WhatsApp at 5am.
 *
 * It also drops the .xlsx dependency. The spreadsheet carried Tamil name,
 * weight, group and order; all four now have catalogue homes -- localName, the
 * option measurement, the product itself, and the facet-value custom field.
 *
 * NO PAGINATION, DELIBERATELY. A purchase list that silently stops at row 1000
 * under-orders food. The order-line query runs unbounded and the count is
 * returned so a caller can notice if it ever grows unreasonable.
 */
@Injectable()
export class PurchaseListService {
    constructor(
        private readonly connection: TransactionalConnection,
        private readonly pdfService: PurchaseListPdfService,
    ) {}

    /**
     * The report as a printable PDF -- the same sheet the team prints by hand.
     *
     * `timeZone` decides the header date. The worker's clock is UTC while the
     * sheet is read in India, so a 21:00 IST run would otherwise be stamped with
     * tomorrow's date: the most likely way for a scheduled report to look wrong
     * to the person holding it.
     */
    async renderPurchaseListPdf(
        ctx: RequestContext,
        input: PurchaseListReportInput,
        options: { timeZone: string; now?: Date } = { timeZone: 'Asia/Kolkata' },
    ): Promise<{ pdf: Buffer; pageCount: number; report: PurchaseListReport }> {
        const report = await this.getPurchaseListReport(ctx, input);
        const html = buildPurchaseListDocument(toPrintRows(report.rows), {
            headerDate: formatHeaderDate(options.now ?? new Date(), options.timeZone),
            logoSrc: loadLogoDataUri(),
        });
        const { pdf, pageCount } = await this.pdfService.render(html);
        return { pdf, pageCount, report };
    }

    async getPurchaseListReport(
        ctx: RequestContext,
        input: PurchaseListReportInput,
    ): Promise<PurchaseListReport> {
        const channelIds = input.channelIds?.length ? input.channelIds : [ctx.channelId];
        const lines = await this.fetchOrderLines(ctx, input, channelIds);

        if (lines.length === 0) {
            return { rows: [], orderCount: 0, lineCount: 0, incompleteCount: 0 };
        }

        const variantIds = [...new Set(lines.map(l => String(l.productVariantId)))];
        const productIds = [...new Set(lines.map(l => String(l.productId)))];

        // Each batched, all resolved in parallel because none depends on another.
        const [
            measures,
            localNames,
            productNames,
            variantLabels,
            stockModes,
            ordNosByProduct,
        ] = await Promise.all([
            this.resolveMeasures(ctx, variantIds),
            this.fetchLocalNames(ctx, productIds),
            this.fetchProductNames(ctx, productIds),
            this.fetchVariantLabels(ctx, variantIds),
            this.fetchStockModes(productIds),
            this.fetchOrdNos(ctx, productIds),
        ]);

        const reportLines: PurchaseLineInput[] = lines.map(line => {
            const productId = String(line.productId);
            const variantId = String(line.productVariantId);
            const variantLabel = variantLabels.get(variantId);
            return {
                productId,
                variantId,
                quantity: line.quantity,
                measure: measures.get(variantId) ?? EMPTY_MEASURE,
                localName: localNames.get(productId) ?? null,
                productName: productNames.get(productId) ?? `Product #${productId}`,
                variantLocalName: variantLabel?.localName ?? null,
                variantName: variantLabel?.name || `Variant #${variantId}`,
                // Raw on purpose -- the builder coerces. See PurchaseLineInput.
                productStockEnabled: stockModes.get(productId),
                ordNos: ordNosByProduct.get(productId) ?? [],
            };
        });

        const rows = buildPurchaseReportRows(reportLines);
        const incompleteCount = rows.filter(r => r.incomplete).length;
        if (incompleteCount > 0) {
            // Loud on purpose: an unmeasured row prints its ordered COUNT, which
            // looks like a real answer. Without this the buyer cannot tell the
            // difference between "5 Pcs" and "we do not know".
            Logger.warn(
                `${incompleteCount} of ${rows.length} purchase-list row(s) include a variant with no measurement — ` +
                    `part of their quantity is the ordered count, not a computed figure. ` +
                    `Set a measurement on the option (Catalog > Option Groups).`,
                loggerCtx,
            );
        }

        return {
            rows,
            orderCount: new Set(lines.map(l => String(l.orderId))).size,
            lineCount: lines.length,
            incompleteCount,
        };
    }

    // ── internals ──────────────────────────────────────────────────────────

    /**
     * Order lines in the window.
     *
     * `DISTINCT` on the candidate order ids matters: every order belongs to its
     * city channel AND __default_channel__, so a caller passing both would get
     * each line twice and the report would order twice the food. Same reason the
     * shared bill-print CTE was fixed.
     *
     * The default state set excludes Delivered and AddingItems: a delivered
     * order has already been bought for, and a live cart is not an order yet.
     */
    private async fetchOrderLines(
        ctx: RequestContext,
        input: PurchaseListReportInput,
        channelIds: ID[],
    ): Promise<Array<{ orderId: ID; productId: ID; productVariantId: ID; quantity: number }>> {
        const states = input.states?.length ? input.states : undefined;
        const stateClause = states
            ? 'O.state IN (?)'
            : `O.state NOT IN ('Delivered', 'Cancelled', 'AddingItems', 'CancellationRequested')`;

        // An AddingItems order has not been placed, so its orderPlacedAt is NULL
        // and `NULL BETWEEN ... AND ...` is never true: asking for that state
        // matched every basket and then dropped every one on the date, returning
        // an empty list with nothing to explain it. Same rule as the bill-print
        // report -- only the states that need it fall back to createdAt, so the
        // orderPlacedAt index stays in use for everyone else.
        const wantsUnplacedOrders = states?.some(state => state === 'AddingItems' || state === 'Draft') ?? false;
        const dateColumn = wantsUnplacedOrders ? 'COALESCE(O2.orderPlacedAt, O2.createdAt)' : 'O2.orderPlacedAt';

        const sql = `
            SELECT OL.orderId       AS orderId,
                   pv.productId     AS productId,
                   OL.productVariantId AS productVariantId,
                   OL.quantity      AS quantity
            FROM \`order\` O
            INNER JOIN (
                SELECT DISTINCT O2.id AS id
                FROM \`order\` O2
                INNER JOIN order_channels_channel ch ON ch.orderId = O2.id AND ch.channelId IN (?)
                WHERE ${dateColumn} BETWEEN ? AND ?
                  AND (O2.customFieldsCancellationreason IS NULL OR O2.customFieldsCancellationreason = '')
                  AND ${stateClause.replace(/\bO\./g, 'O2.')}
            ) cand ON cand.id = O.id
            INNER JOIN order_line OL ON OL.orderId = O.id
            INNER JOIN product_variant pv ON pv.id = OL.productVariantId
            WHERE OL.quantity > 0
        `;
        const params: unknown[] = [channelIds, input.from, input.to];
        if (states) {
            params.push(states);
        }

        const rows = await this.connection.rawConnection.query(sql, params);
        return (rows as any[]).map(r => ({
            orderId: r.orderId,
            productId: r.productId,
            productVariantId: r.productVariantId,
            quantity: Number(r.quantity) || 0,
        }));
    }

    /** Each variant's measurement, read off its option. */
    private async resolveMeasures(ctx: RequestContext, variantIds: string[]) {
        const variants: ProductVariant[] = [];
        for (let i = 0; i < variantIds.length; i += ID_CHUNK_SIZE) {
            const chunk = variantIds.slice(i, i + ID_CHUNK_SIZE);
            const found = await this.connection.getRepository(ctx, ProductVariant).find({
                where: { id: In(chunk), deletedAt: IsNull() },
                relations: ['options'],
            });
            variants.push(...found);
        }
        return resolveVariantMeasures(ctx, this.connection, variants);
    }

    /**
     * `localName` for the report language, falling back to the channel default.
     *
     * Read straight from product_translation: it is a localeString, so there is
     * one row per language and the ORM would hydrate every one of them for every
     * product just to reach a single column.
     */
    private async fetchLocalNames(
        ctx: RequestContext,
        productIds: string[],
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const langs = [ctx.languageCode, LanguageCode.en];
        for (let i = 0; i < productIds.length; i += ID_CHUNK_SIZE) {
            const chunk = productIds.slice(i, i + ID_CHUNK_SIZE);
            const rows = await this.connection.rawConnection.query(
                `SELECT baseId, languageCode, customFieldsLocalname AS localName
                 FROM product_translation
                 WHERE baseId IN (?) AND languageCode IN (?)
                   AND customFieldsLocalname IS NOT NULL AND customFieldsLocalname <> ''`,
                [chunk, langs],
            );
            for (const row of rows as any[]) {
                const key = String(row.baseId);
                // Requested language wins; English only fills a gap.
                if (row.languageCode === ctx.languageCode || !result.has(key)) {
                    result.set(key, row.localName);
                }
            }
        }
        return result;
    }

    /** Product names in the report language — the label fallback. */
    private async fetchProductNames(
        ctx: RequestContext,
        productIds: string[],
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        for (let i = 0; i < productIds.length; i += ID_CHUNK_SIZE) {
            const chunk = productIds.slice(i, i + ID_CHUNK_SIZE);
            const rows = await this.connection.rawConnection.query(
                `SELECT baseId, languageCode, name FROM product_translation
                 WHERE baseId IN (?) AND languageCode IN (?)`,
                [chunk, [ctx.languageCode, LanguageCode.en]],
            );
            for (const row of rows as any[]) {
                const key = String(row.baseId);
                if (row.languageCode === ctx.languageCode || !result.has(key)) {
                    result.set(key, row.name);
                }
            }
        }
        return result;
    }

    /**
     * Variant `localName` AND `name` in the report language.
     *
     * ONE query for both columns, unlike the product side above, which spends two
     * round-trips on two columns of the same rows. Both live on the same
     * product_variant_translation row, so splitting them buys nothing.
     *
     * Blank/NULL localName is skipped rather than stored, so an empty value in
     * the requested language cannot beat a filled English one -- same rule the
     * product query gets from its WHERE clause.
     */
    private async fetchVariantLabels(
        ctx: RequestContext,
        variantIds: string[],
    ): Promise<Map<string, { name: string; localName: string | null }>> {
        const result = new Map<string, { name: string; localName: string | null }>();
        const seenName = new Set<string>();
        const seenLocalName = new Set<string>();
        const langs = [ctx.languageCode, LanguageCode.en];
        for (let i = 0; i < variantIds.length; i += ID_CHUNK_SIZE) {
            const chunk = variantIds.slice(i, i + ID_CHUNK_SIZE);
            const rows = await this.connection.rawConnection.query(
                `SELECT baseId, languageCode, name, customFieldsLocalname AS localName
                 FROM product_variant_translation
                 WHERE baseId IN (?) AND languageCode IN (?)`,
                [chunk, langs],
            );
            for (const row of rows as any[]) {
                const key = String(row.baseId);
                const preferred = row.languageCode === ctx.languageCode;
                const entry = result.get(key) ?? { name: '', localName: null };

                // Each field resolves its own language independently: a Tamil row
                // may carry a name but no localName, and the English localName
                // should still fill that gap rather than being shadowed.
                if (row.name && (preferred || !seenName.has(key))) {
                    entry.name = String(row.name);
                    if (preferred) {
                        seenName.add(key);
                    }
                }
                const localName = row.localName == null ? '' : String(row.localName).trim();
                if (localName && (preferred || !seenLocalName.has(key))) {
                    entry.localName = localName;
                    if (preferred) {
                        seenLocalName.add(key);
                    }
                }
                result.set(key, entry);
            }
        }
        return result;
    }

    /**
     * `productStockEnabled` per product -- true means weight-pool stock, false
     * means Vendure's per-variant stock.
     *
     * Returned RAW (a MySQL tinyint surfaces as 1/0) and coerced by the builder.
     * Not translated, so no language handling and no ctx.
     */
    private async fetchStockModes(productIds: string[]): Promise<Map<string, unknown>> {
        const result = new Map<string, unknown>();
        for (let i = 0; i < productIds.length; i += ID_CHUNK_SIZE) {
            const chunk = productIds.slice(i, i + ID_CHUNK_SIZE);
            const rows = await this.connection.rawConnection.query(
                `SELECT id, customFieldsProductstockenabled AS stockEnabled
                 FROM product WHERE id IN (?)`,
                [chunk],
            );
            for (const row of rows as any[]) {
                result.set(String(row.id), row.stockEnabled);
            }
        }
        return result;
    }

    /**
     * Every `purchaseOrdNo` tagged on a product's facet values.
     *
     * All of them, not the first: this catalogue spells one category several
     * ways ("Vegetables" is facet value 2, 86 and 107), and a product may carry
     * more than one section besides. The caller takes the lowest.
     */
    private async fetchOrdNos(
        ctx: RequestContext,
        productIds: string[],
    ): Promise<Map<string, number[]>> {
        const result = new Map<string, number[]>();
        for (let i = 0; i < productIds.length; i += ID_CHUNK_SIZE) {
            const chunk = productIds.slice(i, i + ID_CHUNK_SIZE);
            const rows = await this.connection.rawConnection.query(
                `SELECT pfv.productId AS productId, fv.customFieldsPurchaseordno AS ordNo
                 FROM product_facet_values_facet_value pfv
                 INNER JOIN facet_value fv ON fv.id = pfv.facetValueId
                 WHERE pfv.productId IN (?) AND fv.customFieldsPurchaseordno IS NOT NULL`,
                [chunk],
            );
            for (const row of rows as any[]) {
                const key = String(row.productId);
                const list = result.get(key) ?? [];
                list.push(Number(row.ordNo));
                result.set(key, list);
            }
        }
        return result;
    }
}

/**
 * The brand mark, inlined as a data URI.
 *
 * Inlined rather than fetched: Playwright's setContent has no base URL, so a
 * relative src resolves to nothing, and a remote one turns every render into a
 * network call that can silently produce a logo-less sheet. Read once and
 * memoised -- the file never changes at runtime.
 *
 * A missing file is NOT fatal. A purchase list with no logo is still a usable
 * purchase list; refusing to send one because of a missing image would be a
 * worse outcome than a plain header.
 */
let logoCache: string | null | undefined;
function loadLogoDataUri(): string | undefined {
    if (logoCache === undefined) {
        try {
            const file = join(__dirname, '..', 'assets', 'kaaikani_logo.png');
            logoCache = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
        } catch {
            Logger.warn('Brand logo not found; rendering the purchase list without it', loggerCtx);
            logoCache = null;
        }
    }
    return logoCache ?? undefined;
}
