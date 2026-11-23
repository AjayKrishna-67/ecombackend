/**
 * The product master that the Purchase List is built from: Tamil name, per-unit
 * weight, group name and the kitchen's category order.
 *
 * This is a faithful port of the delivery dashboard's `/api/tamil-names` route
 * (app/api/tamil-names/route.ts). The report has to move server-side so it can
 * be generated on a schedule and sent to WhatsApp, and the dashboard route is a
 * Next.js request handler that cannot be called from the Vendure worker.
 *
 * WHY THE SPREADSHEET IS STILL THE SOURCE OF TRUTH
 * ------------------------------------------------
 * `ProductVariant.customFields.localName` was added to move Tamil names into the
 * database, but as of 2026-08-06 it is populated on 1 of 752 products. The
 * spreadsheet also carries three things that have no database home at all:
 * `Group Name` (so Apple 250 g / 500 g / 1 KG collapse into one ஆப்பிள் row),
 * `OrdNo` (the order the kitchen team reads the list in) and `Category`. Until
 * those exist as custom fields, the .xlsx IS the master and this parser has to
 * agree with the dashboard's byte for byte, or the scheduled PDF and the
 * hand-printed one will disagree.
 *
 * Pure and I/O-free -- the file reading and caching live in
 * ./services/product-master.service.ts, so every parsing rule here is unit
 * testable against a plain array of rows.
 */

/** One product as the spreadsheet describes it. */
export interface ProductInfo {
    readonly sku: string;
    readonly tamilName: string;
    readonly productName: string;
    /**
     * Weight per unit. Kilograms for weight-priced items; 1 for quantity-priced
     * items like juices, dairy and MRP goods. The Purchase List multiplies
     * weight x ordered qty uniformly for both kinds, which is why a "5 எண்"
     * banana row can legitimately read 5.000.
     */
    readonly weight: number;
    readonly category: string;
    /** Umbrella label -- the row heading on the printed list. */
    readonly groupName: string;
    /**
     * Sort key from the spreadsheet: vegetables first, then fruits, and so on.
     * Missing or unparseable becomes MAX_SAFE_INTEGER so unmatched products sink
     * to the bottom instead of jumping to the top as a 0 would.
     */
    readonly ordNo: number;
}

/** Lookup built from the sheet, indexed both ways the bill rows can be matched. */
export interface ProductMaster {
    readonly productsBySku: Record<string, ProductInfo>;
    /** Keyed by normalized English name, for bill rows with no SKU. */
    readonly productsByName: Record<string, ProductInfo>;
    readonly rowCount: number;
}

export const EMPTY_PRODUCT_MASTER: ProductMaster = {
    productsBySku: {},
    productsByName: {},
    rowCount: 0,
};

// Column aliases, in priority order. The spreadsheet is hand-maintained and has
// been through several header spellings; accepting all of them is cheaper than
// forcing the team to rename columns.
const SKU_KEYS = ['SKU', 'sku', 'Sku', 'SKU_CODE', 'sku_code'] as const;
const TAMIL_KEYS = ['Tamil Name', 'TamilName', 'tamil_name', 'Tamil', 'tamilname'] as const;
const NAME_KEYS = ['Product Name', 'ProductName', 'product_name', 'Name'] as const;
const WEIGHT_KEYS = ['Weight', 'weight'] as const;
const ORD_NO_KEYS = ['OrdNo', 'OrdNumber', 'ordNo', 'Order No'] as const;

/** Header names that identify a workbook as a Tamil-name master. */
export const TAMIL_HEADER_ALIASES: readonly string[] = TAMIL_KEYS;

export type SheetRow = Record<string, unknown>;

/**
 * Collapses case and runs of whitespace so "Green  Grapes" and "green grapes"
 * are the same key. Must stay identical to the dashboard's version -- it is the
 * join key between bill rows and the spreadsheet.
 */
export function normalizeProductName(value: unknown): string {
    return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** First alias present and non-empty, or undefined. */
function pick(row: SheetRow, keys: readonly string[]): unknown {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== '') {
            return row[key];
        }
    }
    return undefined;
}

/** Excel gives numbers as numbers but a re-typed cell as a string. */
function toNumber(raw: unknown, fallback: number): number {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? raw : fallback;
    }
    const parsed = parseFloat(String(raw ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toInteger(raw: unknown, fallback: number): number {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? Math.trunc(raw) : fallback;
    }
    const parsed = parseInt(String(raw ?? ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Builds the lookup from parsed sheet rows.
 *
 * A row without BOTH a SKU and a Tamil name is skipped, exactly as the dashboard
 * does: those are blank spacer rows and section headings, and admitting them
 * would put empty labels on the printed list.
 */
export function buildProductMaster(rows: readonly SheetRow[]): ProductMaster {
    const productsBySku: Record<string, ProductInfo> = {};
    const productsByName: Record<string, ProductInfo> = {};

    for (const row of rows) {
        const sku = String(pick(row, SKU_KEYS) ?? '').trim();
        const tamilName = String(pick(row, TAMIL_KEYS) ?? '').trim();
        if (!sku || !tamilName) {
            continue;
        }
        const productName = String(pick(row, NAME_KEYS) ?? '').trim();
        const info: ProductInfo = {
            sku,
            tamilName,
            productName,
            weight: toNumber(pick(row, WEIGHT_KEYS), 0),
            category: String(row['Category'] ?? '').trim(),
            groupName: String(row['Group Name'] ?? '').trim(),
            ordNo: toInteger(pick(row, ORD_NO_KEYS), Number.MAX_SAFE_INTEGER),
        };
        // Last row wins on a duplicate SKU, matching the dashboard. The sheet is
        // hand-maintained, so duplicates happen; silently keeping the later one
        // is what the team already sees on screen.
        productsBySku[sku] = info;
        const nameKey = normalizeProductName(productName);
        if (nameKey) {
            productsByName[nameKey] = info;
        }
    }

    return {
        productsBySku,
        productsByName,
        rowCount: Object.keys(productsBySku).length,
    };
}

/**
 * Resolves a bill line to its master entry: SKU first, then normalized English
 * name. Returns null when the product is not in the spreadsheet at all -- the
 * caller must still show the line, or an unlisted product silently vanishes
 * from the purchase list and nobody buys it.
 */
export function resolveProductInfo(
    line: { pCode?: string | null; itemName: string },
    master: ProductMaster | null,
): ProductInfo | null {
    if (!master) {
        return null;
    }
    const sku = line.pCode ? String(line.pCode).trim() : '';
    if (sku && master.productsBySku[sku]) {
        return master.productsBySku[sku];
    }
    const nameKey = normalizeProductName(line.itemName);
    if (nameKey && master.productsByName[nameKey]) {
        return master.productsByName[nameKey];
    }
    return null;
}
