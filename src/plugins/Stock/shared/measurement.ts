/**
 * Measurement resolution: how much physical stuff one sellable unit is.
 *
 * The measurement belongs to the ProductOption -- "1/2 KG" means 500 g no
 * matter which product carries it, so it is authored once on the shared option
 * instead of being retyped for every tomato, guava and pomegranate variant.
 * (It used to live on ProductVariant.customFields.weight + stockUnit; both
 * fields were removed.)
 *
 * Since Vendure 3.6 a ProductOptionGroup is shared across products and is
 * ChannelAware, so one "Quantity" group can be authored once and assigned to
 * every product in the catalogue. The option itself carries:
 *
 *   ProductOption.customFields.measureValue : float   e.g. 0.5
 *   ProductOption.customFields.measureUnit  : string  e.g. 'kg'
 *
 * This module is framework-free (no Vendure / NestJS / React imports) so the
 * dashboard bundle can import it too -- same rule as ./stock-units.ts, which
 * owns the unit table this builds on.
 */
import { DEFAULT_STOCK_UNIT, STOCK_UNITS, toBase } from './stock-units';

/** Where a resolved measurement came from. Surfaced for logging + admin UX. */
export type MeasureSource = 'option' | 'none';

/**
 * One variant's resolved measurement.
 *
 * `grams` is null for volume units (litre/ml) and for counted units
 * (piece/packet/dozen) -- there is no density table, so a 1 litre milk pack
 * has no derivable weight. Callers that need weight (shipping, weight pools)
 * MUST handle null rather than coercing it to 0.
 */
export interface VariantMeasure {
  /** Physical weight of one unit in grams, or null if not weight-expressible. */
  readonly grams: number | null;
  /** Magnitude in the unit's own base (g, ml or piece). */
  readonly baseValue: number | null;
  /** Unit code as authored, e.g. 'kg'. Falls back to DEFAULT_STOCK_UNIT. */
  readonly unit: string;
  /** Base unit implied by `unit` -- 'g' | 'ml' | 'piece'. */
  readonly baseUnit: 'g' | 'ml' | 'piece';
  /** Which layer supplied the value. */
  readonly source: MeasureSource;
}

/** A measurement with nothing behind it. Shared instance -- treat as readonly. */
export const EMPTY_MEASURE: VariantMeasure = {
  grams: null,
  baseValue: null,
  unit: DEFAULT_STOCK_UNIT,
  baseUnit: 'piece',
  source: 'none',
};

/**
 * Convert an authored (value, unit) pair into a VariantMeasure.
 *
 * Returns EMPTY_MEASURE for a missing/zero value or an unknown unit code, so a
 * half-filled option row degrades to "no measurement" instead of 0 g -- 0 g
 * would silently divide-by-zero the weight-pool maths in product-stock.
 */
export function toMeasure(
  value: number | string | null | undefined,
  unit: string | null | undefined,
  source: MeasureSource,
): VariantMeasure {
  const unitCode = unit ?? DEFAULT_STOCK_UNIT;
  const unitDef = STOCK_UNITS[unitCode];
  // Coerce before testing: a MySQL `double` can surface as a string depending
  // on the driver path, and Number.isFinite('1') is false -- which would read a
  // perfectly good 1 kg as "no measurement". Same class of bug as the tinyint
  // boolean in ./custom-field-boolean.ts.
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (unitDef == null || numeric == null || !Number.isFinite(numeric) || numeric <= 0) {
    return EMPTY_MEASURE;
  }
  const baseValue = toBase(numeric, unitCode);
  return {
    grams: unitDef.baseUnit === 'g' ? baseValue : null,
    baseValue,
    unit: unitCode,
    baseUnit: unitDef.baseUnit,
    source,
  };
}

/** True when the measurement can drive weight maths (shipping, weight pools). */
export function hasWeight(measure: VariantMeasure): boolean {
  return measure.grams != null && measure.grams > 0;
}

/** True when anything at all resolved -- i.e. not the empty sentinel. */
export function isResolved(measure: VariantMeasure): boolean {
  return measure.source !== 'none';
}
