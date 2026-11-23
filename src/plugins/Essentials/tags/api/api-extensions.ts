import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type CatalogTag implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        value: String!
        key: String!
        productCount: Int!
        variantCount: Int!
    }

    enum TagMatchMode {
        AND
        OR
    }

    extend type Query {
        "All tags (global — shared across every channel)"
        catalogTags: [CatalogTag!]!
        "Prefix autocomplete on tag key (global)"
        tagSuggestions(term: String): [CatalogTag!]!
        "Tags currently attached to a product"
        productTags(productId: ID!): [CatalogTag!]!
        "Tags currently attached to a variant"
        variantTags(variantId: ID!): [CatalogTag!]!
        "Products carrying any/all of the given tags (on product OR any variant), in the active channel"
        productsByTag(tagIds: [ID!]!, matchMode: TagMatchMode = OR, options: ProductListOptions): ProductList!
        "Products directly tagged with a single tag"
        tagProducts(tagId: ID!): [Product!]!
        "Variants tagged with a single tag"
        tagVariants(tagId: ID!): [ProductVariant!]!
    }

    extend type Mutation {
        "Find an existing tag by normalized value, or create it (global)"
        findOrCreateTag(value: String!): CatalogTag!
        "Replace the full set of tags on a product"
        setProductTags(productId: ID!, tagIds: [ID!]!): [CatalogTag!]!
        "Replace the full set of tags on a variant"
        setVariantTags(variantId: ID!, tagIds: [ID!]!): [CatalogTag!]!
        "Delete a tag (removes it from all products/variants)"
        deleteCatalogTag(id: ID!): DeletionResponse!
    }
`;
