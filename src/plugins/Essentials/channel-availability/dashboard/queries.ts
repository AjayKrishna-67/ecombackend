import { graphql } from '@vendure/dashboard';

// Seeded seller name — brands are all sellers EXCEPT this one.
export const DEFAULT_SELLER_NAME = 'Default Seller';

// Default channel code — Vendure's built-in super-admin channel. When the admin
// is scoped to it, the page shows ALL brands; otherwise only the active channel's
// seller.
export const DEFAULT_CHANNEL_CODE = '__default_channel__';

// The admin's currently-selected channel + its owning seller (from the channel
// switcher). Drives which brands the Brand Storefronts page displays.
export const getActiveAdminChannelDocument = graphql(`
    query GetActiveAdminChannel {
        activeChannel {
            id
            code
            seller {
                id
            }
        }
    }
`);

// All sellers; the page filters out the Default Seller to get brand sellers.
export const getBrandSellersDocument = graphql(`
    query GetBrandSellers {
        sellers(options: { take: 500 }) {
            items {
                id
                name
            }
            totalItems
        }
    }
`);

// Existing storefront config, keyed by seller in the page.
export const getBrandStorefrontsDocument = graphql(`
    query GetBrandStorefronts {
        brandStorefronts {
            id
            seller {
                id
            }
            bannerImage {
                id
                name
                preview
            }
            launchStatus
            showInStoreSwitcher
            sortOrder
        }
    }
`);

export const upsertBrandStorefrontDocument = graphql(`
    mutation UpsertBrandStorefront($input: UpsertBrandStorefrontInput!) {
        upsertBrandStorefront(input: $input) {
            id
        }
    }
`);

export const setBrandStorefrontOrderDocument = graphql(`
    mutation SetBrandStorefrontOrder($sellerIds: [ID!]!) {
        setBrandStorefrontOrder(sellerIds: $sellerIds)
    }
`);

export type LaunchStatus = 'OPENING_SOON' | 'LAUNCHED';

export interface StorefrontAsset {
    id: string;
    name: string;
    preview: string;
}

export interface BrandStorefront {
    id: string;
    seller: { id: string };
    bannerImage: StorefrontAsset | null;
    launchStatus: LaunchStatus;
    showInStoreSwitcher: boolean;
    sortOrder: number | null;
}

export interface BrandSeller {
    id: string;
    name: string;
}
