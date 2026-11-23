import gql from 'graphql-tag';

/**
 * Location-first stock editor.
 *
 * `TagMatchMode` is defined by the tags plugin schema, so it is referenced
 * here, never redefined. Reads resolve under the default channel (a location
 * shows products from every channel it serves). Stock values are integers in
 * the variant's BASE unit (grams for kg, count for piece/packet); the display
 * unit is chosen client-side. `ProductPoolStockRow.stockOnHand` null = the
 * pooled product has no pool row at this location yet (offer "create pool").
 */
export const adminApiExtensions = gql`
    type LocationStockRow {
        variantId: ID!
        productId: ID!
        sku: String!
        name: String!
        stockUnit: String!
        baseUnit: String!
        stockOnHand: Int!
        stockAllocated: Int!
    }

    type ProductPoolStockRow {
        productId: ID!
        name: String!
        hasPoolHere: Boolean!
        stockOnHand: Int
        stockAllocated: Int!
    }

    type StockChangeLog {
        id: ID!
        createdAt: DateTime!
        kind: String!
        unit: String!
        targetId: ID!
        targetName: String!
        stockLocationId: ID!
        locationName: String!
        oldOnHand: Int
        newOnHand: Int!
        adminId: ID
        adminName: String!
    }

    type StockChangeHistoryList {
        items: [StockChangeLog!]!
        totalItems: Int!
    }

    input SetVariantStockInput {
        variantId: ID!
        stockLocationId: ID!
        stockOnHand: Int!
    }

    input SetProductPoolStockInput {
        productId: ID!
        stockLocationId: ID!
        stockOnHand: Int!
    }

    input StockChangeHistoryOptions {
        stockLocationId: ID
        kind: String
        targetId: ID
        skip: Int
        take: Int
    }

    extend type Query {
        "Variant-wise stock at a location (products WITHOUT a stock pool). Optional tag/search filter."
        locationVariantStock(
            stockLocationId: ID!
            tagIds: [ID!]
            matchMode: TagMatchMode = OR
            search: String
        ): [LocationStockRow!]!
        "Weight-pool products at a location (products WITH a pool anywhere). hasPoolHere=false means no pool row at this location yet."
        locationProductPoolStock(
            stockLocationId: ID!
            tagIds: [ID!]
            matchMode: TagMatchMode = OR
            search: String
        ): [ProductPoolStockRow!]!
        "SuperAdmin-only audit log of stock changes, newest first."
        stockChangeHistory(options: StockChangeHistoryOptions): StockChangeHistoryList!
    }

    extend type Mutation {
        "Set absolute on-hand for one (variant, location). Rejects variants of a pooled product."
        setVariantStockOnHand(input: SetVariantStockInput!): Boolean!
        "Set the absolute stock pool for one (product, location), in the product's own base unit: grams for a kg-authored product, pieces for a Nos-authored one. Rejects products whose options carry no Measure Value."
        setProductPoolStock(input: SetProductPoolStockInput!): Boolean!
    }
`;
