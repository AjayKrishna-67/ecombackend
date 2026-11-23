/**
 * Single source of truth for stock units, shared by the backend services and
 * the dashboard. Framework-free (no Vendure / React imports) so both the
 * NestJS build and the dashboard (vite) bundle can import it.
 *
 * Model: every quantity is stored as an INTEGER in its `baseUnit`; the display
 * value is `base / factor` rounded to `decimals`. This is what lets a 1500 g
 * row render as "1.5 kg" and a 500 g row render as "500 g" off ONE stored
 * integer — the display unit is chosen at render time, never stored.
 *
 *   MEASURED (fractional, scaled)        COUNTED (whole numbers)
 *     kg    → base g,  factor 1000         piece  → base piece, factor 1
 *     g     → base g,  factor 1            packet → base piece, factor 1
 *     litre → base ml, factor 1000         dozen  → base piece, factor 1
 *     ml    → base ml, factor 1            box    → base piece, factor 1
 *
 * NOTE: variant-wise stock holds whole sellable units, so only COUNTED units
 * are valid there. MEASURED units belong to weight/volume pools (v1 = weight
 * only). See docs/issues/stock-update-tool.md "Unit Model".
 */
export type StockUnitKind = 'measured' | 'counted';

export interface StockUnit {
    code: string;
    label: string;
    baseUnit: 'g' | 'ml' | 'piece';
    factor: number;
    decimals: number;
    kind: StockUnitKind;
}

export const STOCK_UNITS: Record<string, StockUnit> = {
    g: { code: 'g', label: 'Grams', baseUnit: 'g', factor: 1, decimals: 0, kind: 'measured' },
    kg: { code: 'kg', label: 'Kilograms', baseUnit: 'g', factor: 1000, decimals: 3, kind: 'measured' },
    ml: { code: 'ml', label: 'Millilitres', baseUnit: 'ml', factor: 1, decimals: 0, kind: 'measured' },
    litre: { code: 'litre', label: 'Litres', baseUnit: 'ml', factor: 1000, decimals: 3, kind: 'measured' },
    piece: { code: 'piece', label: 'Pieces', baseUnit: 'piece', factor: 1, decimals: 0, kind: 'counted' },
    packet: { code: 'packet', label: 'Packets', baseUnit: 'piece', factor: 1, decimals: 0, kind: 'counted' },
    dozen: { code: 'dozen', label: 'Dozens', baseUnit: 'piece', factor: 1, decimals: 0, kind: 'counted' },
    box: { code: 'box', label: 'Boxes', baseUnit: 'piece', factor: 1, decimals: 0, kind: 'counted' },
};

export const STOCK_UNIT_CODES: string[] = Object.keys(STOCK_UNITS);
export const DEFAULT_STOCK_UNIT = 'piece';

/** Display value (e.g. 1.5 kg) -> stored base integer (e.g. 1500 g). */
export function toBase(displayValue: number, unitCode: string): number {
    const unit = STOCK_UNITS[unitCode] ?? STOCK_UNITS[DEFAULT_STOCK_UNIT];
    return Math.round(displayValue * unit.factor);
}

/** Stored base integer -> display value in the unit's own terms. */
export function fromBase(baseValue: number, unitCode: string): number {
    const unit = STOCK_UNITS[unitCode] ?? STOCK_UNITS[DEFAULT_STOCK_UNIT];
    return +(baseValue / unit.factor).toFixed(unit.decimals);
}

/**
 * Human label for a base-unit integer, switching unit by magnitude:
 * grams >=1000 -> "x.y kg" (trailing zeros trimmed), else "n g"; ml mirrors it
 * with litre; piece-based units render as the plain count + label.
 */
export function formatMeasured(baseValue: number, baseUnit: 'g' | 'ml' | 'piece'): string {
    if (baseUnit === 'piece') {
        return `${baseValue}`;
    }
    const big = baseUnit === 'g' ? 'kg' : 'litre';
    const small = baseUnit;
    if (Math.abs(baseValue) >= 1000) {
        const scaled = +(baseValue / 1000).toFixed(3);
        return `${scaled} ${big}`;
    }
    return `${baseValue} ${small}`;
}

// ── Back-compat helpers for the weight-pool block (product-stock). ──
// These keep the existing kg<->g call sites working after Issue 3 extracted
// the math here. New code should prefer toBase/fromBase with a unit code.
export function toKg(grams: number): number {
    return +(grams / 1000).toFixed(3);
}

export function toGrams(kg: number): number {
    return Math.round(kg * 1000);
}
