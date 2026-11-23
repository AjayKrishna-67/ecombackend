import gql from 'graphql-tag';

/**
 * Tag-based multi-channel price matrix.
 *
 * `TagMatchMode` and `ProductListOptions` are already defined by the tags
 * plugin / core schema, so they are referenced here, never redefined.
 *
 * Prices are integer minor units (the core `Money` scalar). A cell with
 * `assigned: false` is a variant not sold in that channel (locked, never
 * writable). A cell with `assigned: true` and `price: null` is assigned but
 * has no price row yet (editable, blank).
 */
export const adminApiExtensions = gql`
    type PriceMatrixChannel {
        id: ID!
        code: String!
        currencyCode: CurrencyCode!
    }

    type PriceMatrixCell {
        channelId: ID!
        currencyCode: CurrencyCode!
        price: Money
        assigned: Boolean!
    }

    type PriceMatrixRow {
        variantId: ID!
        productId: ID!
        name: String!
        sku: String!
        cells: [PriceMatrixCell!]!
    }

    type VariantPriceMatrix {
        "Channel columns, in stable order"
        channels: [PriceMatrixChannel!]!
        "Variant rows for the current page of matched products"
        rows: [PriceMatrixRow!]!
        "Total matched products (pagination unit is the product)"
        totalItems: Int!
    }

    input SetVariantChannelPriceInput {
        variantId: ID!
        channelId: ID!
        price: Money!
        currencyCode: CurrencyCode
    }

    type SetVariantChannelPricesResult {
        updatedCount: Int!
        variantIds: [ID!]!
    }

    type PriceChangeLog {
        id: ID!
        createdAt: DateTime!
        variantId: ID!
        variantName: String!
        channelId: ID!
        channelName: String!
        oldPrice: Money
        newPrice: Money!
        currencyCode: CurrencyCode!
        adminId: ID
        adminName: String!
    }

    type PriceChangeHistoryList {
        items: [PriceChangeLog!]!
        totalItems: Int!
    }

    input PriceChangeHistoryOptions {
        variantId: ID
        channelId: ID
        adminId: ID
        from: DateTime
        to: DateTime
        skip: Int
        take: Int
    }

    extend type Query {
        "Variant x channel price grid for all variants of products carrying the given tag(s). Resolve in the default/master channel."
        variantPriceMatrix(
            tagIds: [ID!]!
            matchMode: TagMatchMode = OR
            options: ProductListOptions
        ): VariantPriceMatrix!
        "SuperAdmin-only audit log of variant x channel price changes, newest first."
        priceChangeHistory(options: PriceChangeHistoryOptions): PriceChangeHistoryList!
    }

    extend type Mutation {
        "Atomically set per-(variant,channel) prices. Rejects unassigned cells. Triggers cart price-sync."
        setVariantChannelPrices(updates: [SetVariantChannelPriceInput!]!): SetVariantChannelPricesResult!
    }
`;
