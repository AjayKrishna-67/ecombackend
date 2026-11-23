import { graphql } from '@vendure/dashboard';

export const getBannersDocument = graphql(`
    query GetCustomBanners($options: CustomBannerListOptions) {
        customBanners(options: $options) {
            items {
                id
                createdAt
                updatedAt
                assets {
                    id
                    name
                    preview
                }
            }
            totalItems
        }
    }
`);

export const createBannerDocument = graphql(`
    mutation CreateCustomBanner($input: CreateCustomBannerInput!) {
        createCustomBanner(input: $input) {
            id
        }
    }
`);

export const updateBannerDocument = graphql(`
    mutation UpdateCustomBanner($input: UpdateCustomBannerInput!) {
        updateCustomBanner(input: $input) {
            id
        }
    }
`);

export const deleteBannerDocument = graphql(`
    mutation DeleteCustomBanner($id: ID!) {
        deleteCustomBanner(id: $id) {
            result
            message
        }
    }
`);

export interface BannerAsset {
    id: string;
    name: string;
    preview: string;
}

export interface Banner {
    id: string;
    createdAt: string;
    updatedAt: string;
    assets: BannerAsset[];
}
