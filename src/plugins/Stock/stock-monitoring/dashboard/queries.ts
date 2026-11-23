import { graphql } from '@vendure/dashboard';

export const lowStockDocument = graphql(`
    query ProductVariantsWithLowStock($skip: Int, $take: Int) {
        productVariantsWithLowStock(skip: $skip, take: $take) {
            items {
                id
                name
                enabled
                productId
                stockLevels {
                    stockOnHand
                }
            }
            totalItems
        }
    }
`);

export interface LowStockVariant {
    id: string;
    name: string;
    enabled: boolean;
    productId: string;
    stockLevels: Array<{ stockOnHand: number }>;
}
