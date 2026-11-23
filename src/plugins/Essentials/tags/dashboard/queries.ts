import { graphql } from '@vendure/dashboard';

export const tagSuggestionsDocument = graphql(`
    query TagSuggestions($term: String) {
        tagSuggestions(term: $term) {
            id
            value
            key
        }
    }
`);

export const productTagsDocument = graphql(`
    query ProductTags($productId: ID!) {
        productTags(productId: $productId) {
            id
            value
            key
        }
    }
`);

export const variantTagsDocument = graphql(`
    query VariantTags($variantId: ID!) {
        variantTags(variantId: $variantId) {
            id
            value
            key
        }
    }
`);

export const findOrCreateTagDocument = graphql(`
    mutation FindOrCreateTag($value: String!) {
        findOrCreateTag(value: $value) {
            id
            value
            key
        }
    }
`);

export const setProductTagsDocument = graphql(`
    mutation SetProductTags($productId: ID!, $tagIds: [ID!]!) {
        setProductTags(productId: $productId, tagIds: $tagIds) {
            id
            value
            key
        }
    }
`);

export const setVariantTagsDocument = graphql(`
    mutation SetVariantTags($variantId: ID!, $tagIds: [ID!]!) {
        setVariantTags(variantId: $variantId, tagIds: $tagIds) {
            id
            value
            key
        }
    }
`);

export const catalogTagsDocument = graphql(`
    query CatalogTags {
        catalogTags {
            id
            value
            key
            productCount
            variantCount
        }
    }
`);

export const tagProductsDocument = graphql(`
    query TagProducts($tagId: ID!) {
        tagProducts(tagId: $tagId) {
            id
            name
        }
    }
`);

export const tagVariantsDocument = graphql(`
    query TagVariants($tagId: ID!) {
        tagVariants(tagId: $tagId) {
            id
            name
            sku
            product {
                id
            }
        }
    }
`);

export const deleteCatalogTagDocument = graphql(`
    mutation DeleteCatalogTag($id: ID!) {
        deleteCatalogTag(id: $id) {
            result
            message
        }
    }
`);

export interface TagDto {
    id: string;
    value: string;
    key: string;
    productCount?: number;
    variantCount?: number;
}
