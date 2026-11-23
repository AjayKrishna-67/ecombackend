import { graphql } from '@vendure/dashboard';

export const variantStockLevelsDocument = graphql(`
    query VariantStockLevels($id: ID!) {
        productVariant(id: $id) {
            id
            stockLevels {
                stockLocationId
                stockOnHand
                stockAllocated
                stockLocation {
                    id
                    name
                }
            }
        }
    }
`);

export const stockLocationsDocument = graphql(`
    query StockLocationsForVariantStock {
        stockLocations {
            items {
                id
                name
            }
        }
    }
`);

export const deleteStockLevelDocument = graphql(`
    mutation DeleteStockLevel($productVariantId: ID!, $stockLocationId: ID!) {
        deleteStockLevel(productVariantId: $productVariantId, stockLocationId: $stockLocationId)
    }
`);

export interface VariantStockLevel {
    stockLocationId: string;
    stockOnHand: number;
    stockAllocated: number;
    stockLocation: { id: string; name: string };
}

export interface StockLocationOption {
    id: string;
    name: string;
}
