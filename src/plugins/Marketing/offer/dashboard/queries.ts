import { graphql } from '@vendure/dashboard';

export const getOffersDocument = graphql(`
    query GetOffers {
        allBannerPopup {
            items {
                id
                isPreview
                asset {
                    id
                    name
                    preview
                    source
                }
                product {
                    id
                    name
                }
                collection {
                    id
                    name
                }
                productVariant {
                    id
                    name
                    sku
                }
            }
            totalItems
        }
    }
`);

export const createOfferDocument = graphql(`
    mutation CreateBannerPopup($input: CreateBannerPopupInput!) {
        createBannerPopup(input: $input) {
            id
        }
    }
`);

export const updateOfferDocument = graphql(`
    mutation UpdateBannerPopup($input: UpdateBannerPopupInput!) {
        updateBannerPopup(input: $input) {
            id
            isPreview
        }
    }
`);

export const deleteOfferDocument = graphql(`
    mutation DeleteBannerPopup($id: ID!) {
        deleteBannerPopup(id: $id) {
            result
        }
    }
`);

export const searchProductsDocument = graphql(`
    query OfferSearchProducts($term: String!) {
        products(options: { take: 20, filter: { name: { contains: $term } } }) {
            items {
                id
                name
            }
        }
    }
`);

export const searchCollectionsDocument = graphql(`
    query OfferSearchCollections($term: String!) {
        collections(options: { take: 20, filter: { name: { contains: $term } } }) {
            items {
                id
                name
            }
        }
    }
`);

export const searchVariantsDocument = graphql(`
    query OfferSearchVariants($term: String!) {
        productVariants(options: { take: 20, filter: { name: { contains: $term } } }) {
            items {
                id
                name
                sku
            }
        }
    }
`);

export type TargetKind = 'product' | 'collection' | 'variant';

export interface OfferAsset {
    id: string;
    name: string;
    preview: string;
    source: string;
}

export interface Offer {
    id: string;
    isPreview: boolean;
    asset: OfferAsset;
    product: { id: string; name: string } | null;
    collection: { id: string; name: string } | null;
    productVariant: { id: string; name: string; sku: string } | null;
}

export interface TargetOption {
    id: string;
    label: string;
}
