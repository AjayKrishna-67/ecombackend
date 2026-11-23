import { isCustomFieldTrue } from '../../Stock/shared/custom-field-boolean';
import { VariantMeasure } from '../../Stock/shared/measurement';

/**
 * Turns order lines into the printed Purchase List, using catalogue data only --
 * no spreadsheet.
 *
 *   OrdNo              FacetValue.customFields.purchaseOrdNo  (lowest wins)
 *   Item Name          localName of the product OR the variant -- see below
 *   Qty / Pcs          Σ (variant measurement x ordered quantity)
 *
 * WHY THE UNIT DECIDES THE MATHS
 * ------------------------------
 * Two different questions hide behind one column. For a weighed product the
 * buyer needs a WEIGHT: 15 orders of a 500 g pack is 7.5 kg to buy. For a
 * counted product they need a COUNT of pieces: 5 orders of a 6-piece egg tray
 * is 30 Pcs to buy, and 5 orders of a "1 packet" paneer is 5 Pcs. The maths is
 * the same either way -- measurement x ordered quantity -- only the base unit
 * differs. That is why a paneer packet must be authored as 1 packet, never as
 * "500 piece": the 500 is its weight, and it would be summed as pieces.
 *
 * `VariantMeasure.baseUnit` already encodes exactly this distinction ('g' | 'ml'
 * | 'piece'), so the report reads it rather than re-deriving it. That is also
 * why a product whose variants mix units yields SEPARATE rows per unit instead
 * of one nonsense total -- adding kilograms to pieces is not an arithmetic
 * problem, it is a category error, and quietly picking one would send the buyer
 * the wrong number.
 *
 * WHY SOME ROWS ARE PER-PRODUCT AND OTHERS PER-VARIANT
 * ----------------------------------------------------
 * Rolling variants up is only useful when the variants are interchangeable at
 * the point of purchase. Three pack sizes of tomato come off one crate, so the
 * buyer wants "தக்காளி 3.5 kg" -- which pack it becomes is a packing decision,
 * made later. The same holds for counted packs of one produce: amla sold as
 * 10 nos and 25 nos is one crate of amla, so the buyer wants "நெல்லிக்காய்
 * 45 Pcs", not two rows. Six flavours of yoghurt are different: mango and
 * greek are different SKUs on the supplier's invoice, and "தயிர் 27 Pcs" tells
 * the buyer nothing they can act on.
 *
 * ONE catalogue fact says which case a product is in, so the report reads it
 * rather than adding a switch of its own:
 *
 *   productStockEnabled === true   weight-pool stock: the variants are one
 *                                  thing in different packs -> ONE product row
 *   productStockEnabled === false  the merchant tracks stock PER VARIANT, i.e.
 *                                  already treats them as distinct things ->
 *                                  one row per variant
 *
 * The unit does NOT split a pooled product. An earlier rule gave every counted
 * pack its own row, on the theory that counted packs are bought as named packs;
 * in this catalogue every pooled counted product is pack sizes of one produce
 * (amla 10 / 25 nos, lemon 5 / 10 / 20 nos), and the sheet came out one line
 * per pack size. A product whose flavours must be bought separately belongs on
 * per-variant stock, which is what makes them distinct things anyway.
 *
 * WHY ROWS ARE ALSO MERGED ON THEIR LABEL
 * ---------------------------------------
 * The catalogue holds duplicates: the same produce created twice as separate
 * products, each with its own variants (Idukki's பீட்ரூட்(ஊட்டி) is three
 * products). Grouped by id, the sheet printed two rows with one label and left
 * the buyer to add them up. Two rows the buyer reads as one thing ARE one
 * thing, so after the id-based buckets are built, rows with the same printed
 * label and unit are merged. The unit stays in the key -- kilograms and pieces
 * of one label are still two different questions.
 *
 * Pure: no Vendure, no DB. The service hydrates, this decides.
 */

/** What the caller must supply for one order line. */
export interface PurchaseLineInput {
    readonly productId: string;
    readonly variantId: string;
    /** Units ordered. */
    readonly quantity: number;
    /** Resolved by the shared measure resolver from the variant's option. */
    readonly measure: VariantMeasure;
    /** Product.customFields.localName for the report language. */
    readonly localName?: string | null;
    /** Product name, the fallback label. */
    readonly productName: string;
    /** ProductVariant.customFields.localName for the report language. */
    readonly variantLocalName?: string | null;
    /** Variant name, the fallback label on a per-variant row. */
    readonly variantName: string;
    /**
     * Product.customFields.productStockEnabled, RAW.
     *
     * Deliberately `unknown` and coerced here rather than accepted as a boolean.
     * MySQL stores it as tinyint, so it arrives as 1/0 and `=== true` reads every
     * enabled product as disabled -- the exact comparison that silently took 182
     * products off weight-pool stock for six weeks (see the backfill migration
     * 1785912400000). Coercing at the point of USE means no caller can get it
     * wrong, and getting it wrong here would split the whole sheet per-variant.
     */
    readonly productStockEnabled: unknown;
    /** purchaseOrdNo of every facet value on the product. Nulls already dropped. */
    readonly ordNos: readonly number[];
}

/** How a quantity is expressed on the printed sheet. */
export type PurchaseUnitKind = 'WEIGHT' | 'VOLUME' | 'COUNT';

/** Whether a row speaks for a whole product or for one variant of it. */
export type PurchaseRowScope = 'PRODUCT' | 'VARIANT';

export interface PurchaseReportRow {
    /** Section number, or null when the product carries no tagged facet value. */
    readonly ordNo: number | null;
    /**
     * Printed label. Tamil first, English only as a rescue:
     *   PRODUCT row  Product.localName ?? Product.name
     *   VARIANT row  Variant.localName ?? Variant.name
     * A VARIANT row never falls back to Product.localName -- that would print
     * several identically-labelled rows carrying different numbers, which is
     * Tamil but unusable.
     */
    readonly label: string;
    readonly productId: string;
    /** Set on a VARIANT row, null on a PRODUCT row. */
    readonly variantId: string | null;
    readonly scope: PurchaseRowScope;
    /** Kilograms for WEIGHT, litres for VOLUME, whole units for COUNT. */
    readonly totalQty: number;
    readonly unitKind: PurchaseUnitKind;
    /** 'kg' | 'l' | 'Pcs' -- what to print beside the number. */
    readonly unitLabel: string;
    /** Distinct variants summed into this row. Always 1 on a VARIANT row. */
    readonly variantCount: number;
    /** True when any line in this row had no usable magnitude -- part of the
     *  quantity is then an ordered count (or, on a weighed row, missing). */
    readonly incomplete: boolean;
}

const UNIT_KIND: Record<VariantMeasure['baseUnit'], PurchaseUnitKind> = {
    g: 'WEIGHT',
    ml: 'VOLUME',
    piece: 'COUNT',
};

const UNIT_LABEL: Record<PurchaseUnitKind, string> = {
    WEIGHT: 'kg',
    VOLUME: 'l',
    COUNT: 'Pcs',
};

/**
 * Lowest tagged section wins.
 *
 * A product is normally in several facets at once -- Vegetables AND Ready to Eat
 * AND New Arrivals. Lowest is the rule because the sections are authored
 * broadest-first (1 = vegetables), so the smallest number is the aisle the buyer
 * actually walks to. Untagged returns null and sorts last, never 0, which would
 * put unclassified products at the TOP of the buyer's sheet.
 */
export function resolveOrdNo(ordNos: readonly number[]): number | null {
    const valid = ordNos.filter(n => Number.isFinite(n));
    return valid.length ? Math.min(...valid) : null;
}

/**
 * Does this line get its own row, or does it roll up into its product?
 *
 * See the header note: per-variant stock splits, weight-pool stock rolls up,
 * whatever the unit. Coerced here because MySQL hands the flag over as a
 * tinyint (see PurchaseLineInput.productStockEnabled).
 */
export function isVariantScoped(line: Pick<PurchaseLineInput, 'productStockEnabled'>): boolean {
    return !isCustomFieldTrue(line.productStockEnabled);
}

/** The label as the buyer reads it: Unicode-composed, one space between words,
 *  case folded (Tamil has no case; the English fallback does). */
function labelKey(label: string): string {
    return label.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Merges rows that print the same label in the same unit -- see the header
 * note on duplicate products. A merged row speaks for more than one product,
 * so it is PRODUCT-scoped with no variant id and carries the first product's
 * id; its section is the lowest of the merged sections, its variant count the
 * sum (variants are disjoint across products), and it is incomplete if any
 * part of it was.
 */
export function mergeDuplicateLabels(rows: readonly PurchaseReportRow[]): PurchaseReportRow[] {
    const merged = new Map<string, PurchaseReportRow>();
    for (const row of rows) {
        const key = `${labelKey(row.label)}::${row.unitKind}`;
        const prev = merged.get(key);
        if (!prev) {
            merged.set(key, row);
            continue;
        }
        merged.set(key, {
            ...prev,
            ordNo: resolveOrdNo([prev.ordNo, row.ordNo].filter((n): n is number => n != null)),
            variantId: null,
            scope: 'PRODUCT',
            totalQty: prev.totalQty + row.totalQty,
            variantCount: prev.variantCount + row.variantCount,
            incomplete: prev.incomplete || row.incomplete,
        });
    }
    return [...merged.values()];
}

export function buildPurchaseReportRows(
    lines: readonly PurchaseLineInput[],
): PurchaseReportRow[] {
    interface Bucket {
        ordNos: number[];
        label: string;
        productId: string;
        variantId: string | null;
        scope: PurchaseRowScope;
        base: number;
        unitKind: PurchaseUnitKind;
        variants: Set<string>;
        unmeasured: boolean;
    }
    const buckets = new Map<string, Bucket>();

    for (const line of lines) {
        const unitKind = UNIT_KIND[line.measure.baseUnit];
        const variantScoped = isVariantScoped(line);

        // The 'p:'/'v:' prefix is load-bearing, not decoration: product and
        // variant ids come from different sequences and collide constantly --
        // product 971 and variant 971 both exist. Without it a variant row could
        // silently merge into an unrelated product's row.
        const key = variantScoped
            ? `v:${line.variantId}::${unitKind}`
            : `p:${line.productId}::${unitKind}`;
        const label = variantScoped
            ? (line.variantLocalName ?? '').trim() || line.variantName
            : (line.localName ?? '').trim() || line.productName;

        const bucket = buckets.get(key) ?? {
            ordNos: [],
            label,
            productId: line.productId,
            variantId: variantScoped ? line.variantId : null,
            scope: variantScoped ? ('VARIANT' as const) : ('PRODUCT' as const),
            base: 0,
            unitKind,
            variants: new Set<string>(),
            unmeasured: false,
        };

        // Measurement x ordered quantity, whatever the unit: 250 g x 4 is
        // 1000 g, a 6-piece tray x 5 is 30 pieces -- the same draw the piece
        // pool takes in pool-measure.ts. A line with no magnitude
        // (EMPTY_MEASURE, which reads as COUNT) falls back to the ordered
        // quantity, the only number there is.
        const magnitude = line.measure.baseValue;
        if (magnitude != null && magnitude > 0) {
            bucket.base += magnitude * line.quantity;
        } else if (unitKind === 'COUNT') {
            bucket.base += line.quantity;
        }
        // A variant with nothing behind it still contributes its ORDERED COUNT,
        // because a product missing from the purchase list is a product nobody
        // buys. But `unmeasured` records that the number was assumed rather than
        // derived: EMPTY_MEASURE carries baseUnit 'piece', so an unmeasured
        // weighed vegetable would otherwise print as a confident "4 Pcs" -- a
        // guess wearing the same clothes as a fact. One such line taints the
        // whole row: now that pack sizes roll up, a total built from a measured
        // 10-nos pack and an unmeasured 25-nos pack is still a guess.
        if (magnitude == null || magnitude <= 0) {
            bucket.unmeasured = true;
        }

        bucket.ordNos.push(...line.ordNos);
        bucket.variants.add(line.variantId);
        buckets.set(key, bucket);
    }

    const rows: PurchaseReportRow[] = mergeDuplicateLabels([...buckets.values()].map(b => ({
        ordNo: resolveOrdNo(b.ordNos),
        label: b.label,
        productId: b.productId,
        variantId: b.variantId,
        scope: b.scope,
        // g -> kg and ml -> l so the sheet reads in the units the team buys in.
        totalQty: b.unitKind === 'COUNT' ? b.base : b.base / 1000,
        unitKind: b.unitKind,
        unitLabel: UNIT_LABEL[b.unitKind],
        variantCount: b.variants.size,
        incomplete: b.unmeasured,
    })));

    rows.sort((a, b) => {
        // null ordNo last, not first -- Infinity rather than a 0 default.
        const ao = a.ordNo ?? Number.MAX_SAFE_INTEGER;
        const bo = b.ordNo ?? Number.MAX_SAFE_INTEGER;
        if (ao !== bo) {
            return ao - bo;
        }
        // Tamil collation: code-point order is not the order a Tamil reader scans.
        return a.label.localeCompare(b.label, 'ta');
    });
    return rows;
}
