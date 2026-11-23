import { ProductInfo, ProductMaster, normalizeProductName, resolveProductInfo } from './product-master';

/**
 * Aggregation for the Purchase List: how much of each thing to buy.
 *
 * Port of the dashboard's `aggregated` memo (app/reports/page.tsx:3249). Pure so
 * the scheduled PDF and the hand-printed one can be proven to agree.
 */

/** One printed line: an umbrella product and the total weight to buy. */
export interface PurchaseRow {
    /** Stable group key -- normalized Group Name, or the item name when unmatched. */
    readonly key: string;
    /** Tamil umbrella label, e.g. "மாதுளை". */
    readonly groupName: string;
    /** Tamil variant name, used only when groupName is empty. */
    readonly tamilName: string;
    /** English fallback when neither Tamil label resolves. */
    readonly englishName: string;
    /** Sum of weight x ordered qty across every variant in the group. */
    readonly totalQty: number;
    readonly ordNo: number;
    readonly category: string;
    /** Distinct variants summed into this group. Shown on screen, not on the PDF. */
    readonly variantCount: number;
}

/** The only fields of a bill row this needs. */
export interface PurchaseSourceLine {
    readonly pCode?: string | null;
    readonly itemName: string;
    readonly qty: number;
}

/**
 * Rolls order lines up into one row per product group.
 *
 * Grouping is by the spreadsheet's `Group Name`, which is the whole point: a
 * customer buying 250 g, 500 g and 1 KG of apples is one purchase decision, so
 * the buyer wants "ஆப்பிள் 2.000", not three lines. A product missing from the
 * spreadsheet becomes its own single-variant group keyed by item name rather
 * than being dropped -- an unlisted product that silently disappears is a
 * product nobody buys, which is far worse than an untranslated label.
 *
 * Sort is by `OrdNo` first (the kitchen team's reading order: vegetables, then
 * fruits, then greens), then Tamil-collated alphabetical within the same OrdNo.
 * `localeCompare(_, 'ta')` matters -- ASCII ordering of Tamil code points is not
 * the order a Tamil reader scans.
 */
export function aggregatePurchaseRows(
    lines: readonly PurchaseSourceLine[],
    master: ProductMaster | null,
): PurchaseRow[] {
    const rows = new Map<string, {
        key: string;
        groupName: string;
        tamilName: string;
        englishName: string;
        totalQty: number;
        ordNo: number;
        category: string;
    }>();
    // Counted separately from totalQty: two lines of the same variant must not
    // inflate the variant count, so a Set per group rather than an increment.
    const variantsByGroup = new Map<string, Set<string>>();

    for (const line of lines) {
        const info: ProductInfo | null = resolveProductInfo(line, master);
        const groupName = info?.groupName ?? '';
        const groupKey = groupName
            ? normalizeProductName(groupName)
            : `_unmatched:${normalizeProductName(line.itemName)}`;
        const variantId = info?.sku ?? line.itemName;

        // An unmatched product has no weight, so it contributes 0.000 and still
        // prints -- deliberately visible as a zero rather than absent.
        const totalForLine = (info?.weight ?? 0) * line.qty;

        const variants = variantsByGroup.get(groupKey) ?? new Set<string>();
        variants.add(variantId);
        variantsByGroup.set(groupKey, variants);

        const existing = rows.get(groupKey);
        if (existing) {
            existing.totalQty += totalForLine;
        } else {
            rows.set(groupKey, {
                key: groupKey,
                groupName,
                tamilName: info?.tamilName ?? '',
                englishName: info?.productName || line.itemName,
                totalQty: totalForLine,
                ordNo: info?.ordNo ?? Number.MAX_SAFE_INTEGER,
                category: info?.category ?? '',
            });
        }
    }

    const result: PurchaseRow[] = [...rows.values()].map(row => ({
        ...row,
        variantCount: variantsByGroup.get(row.key)?.size ?? 1,
    }));

    result.sort((a, b) => {
        if (a.ordNo !== b.ordNo) {
            return a.ordNo - b.ordNo;
        }
        return purchaseLabel(a).localeCompare(purchaseLabel(b), 'ta');
    });
    return result;
}

/** The label actually printed: Tamil group, else Tamil variant, else English. */
export function purchaseLabel(row: Pick<PurchaseRow, 'groupName' | 'tamilName' | 'englishName'>): string {
    return row.groupName || row.tamilName || row.englishName;
}
