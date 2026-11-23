import { graphql } from '@vendure/dashboard';

export const stockLocationsDocument = graphql(`
    query StockLocationsForProductStock {
        stockLocations {
            items {
                id
                name
            }
        }
    }
`);

export const productStockLevelsDocument = graphql(`
    query ProductStockLevels($productId: ID!) {
        productStockLevels(productId: $productId) {
            id
            productId
            stockLocationId
            stockOnHand
            stockAllocated
        }
    }
`);

export const productStockOverviewDocument = graphql(`
    query ProductStockOverview($productId: ID!) {
        productStockOverview(productId: $productId) {
            productId
            stockOnHand
            stockAllocated
            availableWeight
            baseUnit
            variants {
                variantId
                sku
                name
                weight
                availableStock
                stockOnHand
                stockAllocated
            }
            excludedVariants {
                variantId
                sku
                name
                measure
                source
                reason
            }
        }
    }
`);

export const setProductStockDocument = graphql(`
    mutation SetProductStock($input: SetProductStockInput!) {
        setProductStock(input: $input) {
            id
            stockOnHand
        }
    }
`);

export const removeProductStockDocument = graphql(`
    mutation RemoveProductStock($productId: ID!) {
        removeProductStock(productId: $productId)
    }
`);

export const resyncProductStockDocument = graphql(`
    mutation ResyncProductStock($productId: ID!) {
        resyncProductStock(productId: $productId)
    }
`);

/**
 * Persists the `productStockEnabled` toggle on its own, rather than riding on
 * the product page's form and its Update button.
 *
 * The toggle used to only call `form.setValue()`. That turned the switch blue
 * but wrote nothing, and the whole Product Stock block below it immediately
 * behaved as if product-level stock were live -- while the backend strategy,
 * reading the unchanged database value, kept using per-variant stock and never
 * touched the weight pool. Silent, and it allowed overselling.
 *
 * Writing it directly makes what you see the thing that is stored.
 */
export const setProductStockEnabledDocument = graphql(`
    mutation SetProductStockEnabled($id: ID!, $enabled: Boolean!) {
        updateProduct(input: { id: $id, customFields: { productStockEnabled: $enabled } }) {
            id
            customFields {
                productStockEnabled
            }
        }
    }
`);

/**
 * The parent product of a variant, and whether its pool is switched on.
 *
 * Read on the VARIANT page, where the editable Stock box belongs to the pool
 * rather than to the variant. Uses the core `productVariant` query — the pool
 * plugin exposes the numbers but not the parent link, and inventing a resolver
 * for something core already answers would be a second source of truth.
 */
export const variantPoolContextDocument = graphql(`
    query VariantPoolContext($id: ID!) {
        productVariant(id: $id) {
            id
            product {
                id
                name
                customFields {
                    productStockEnabled
                }
            }
        }
    }
`);

export interface StockLocationOption {
    id: string;
    name: string;
}

export interface ProductStockLevel {
    id: string;
    productId: string;
    stockLocationId: string;
    stockOnHand: number;
    stockAllocated: number;
}

export interface VariantStockInfo {
    variantId: string;
    sku: string;
    name: string;
    weight: number;
    availableStock: number;
    stockOnHand: number;
    stockAllocated: number;
}

/** A variant the pool leaves out, and why. Empty list is the healthy state. */
export interface ExcludedVariantInfo {
    variantId: string;
    sku: string;
    name: string;
    /** e.g. '500 ml'; null when the variant carries no measurement at all. */
    measure: string | null;
    /** 'option' | 'none' — whether an option supplied the measurement. */
    source: string;
    /** 'UNIT_MISMATCH' | 'NO_MEASUREMENT' */
    reason: string;
}

export interface ProductStockOverview {
    productId: string;
    stockOnHand: number;
    stockAllocated: number;
    availableWeight: number;
    /** What the pool integers count: 'g', 'ml' or 'piece'. */
    baseUnit: string;
    variants: VariantStockInfo[];
    excludedVariants: ExcludedVariantInfo[];
}
