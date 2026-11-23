import { graphql } from '@vendure/dashboard';

// Fragment-free: the Dashboard's typed `graphql()` codegen inlines fields, so we
// repeat the AddonGroup selection where needed rather than share an Angular-style
// fragment. Prices are Money (minor units) — format with useLocalFormat.

export const getAddonGroupsDocument = graphql(`
    query GetAddonGroupsList($options: AddonGroupListOptions) {
        addonGroups(options: $options) {
            items {
                id
                createdAt
                updatedAt
                name
                description
                selectionType
                isRequired
                minSelections
                maxSelections
                sortOrder
                enabled
                items {
                    id
                    name
                    price
                    enabled
                }
            }
            totalItems
        }
    }
`);

export const getAddonGroupDocument = graphql(`
    query GetAddonGroup($id: ID!) {
        addonGroup(id: $id) {
            id
            createdAt
            updatedAt
            name
            description
            selectionType
            isRequired
            minSelections
            maxSelections
            sortOrder
            enabled
            items {
                id
                createdAt
                name
                price
                sku
                isDefault
                minQuantity
                maxQuantity
                sortOrder
                enabled
                image {
                    id
                    preview
                }
            }
        }
    }
`);

export const createAddonGroupDocument = graphql(`
    mutation CreateAddonGroup($input: CreateAddonGroupInput!) {
        createAddonGroup(input: $input) {
            id
        }
    }
`);

export const updateAddonGroupDocument = graphql(`
    mutation UpdateAddonGroup($input: UpdateAddonGroupInput!) {
        updateAddonGroup(input: $input) {
            id
        }
    }
`);

export const deleteAddonGroupDocument = graphql(`
    mutation DeleteAddonGroup($id: ID!) {
        deleteAddonGroup(id: $id) {
            result
            message
        }
    }
`);

export const createAddonItemDocument = graphql(`
    mutation CreateAddonItem($input: CreateAddonItemInput!) {
        createAddonItem(input: $input) {
            id
        }
    }
`);

export const updateAddonItemDocument = graphql(`
    mutation UpdateAddonItem($input: UpdateAddonItemInput!) {
        updateAddonItem(input: $input) {
            id
        }
    }
`);

export const deleteAddonItemDocument = graphql(`
    mutation DeleteAddonItem($id: ID!) {
        deleteAddonItem(id: $id) {
            result
            message
        }
    }
`);

export const getVariantsWithAddonGroupDocument = graphql(`
    query GetVariantsWithAddonGroup($addonGroupId: ID!) {
        variantsWithAddonGroup(addonGroupId: $addonGroupId) {
            id
            name
            sku
            productId
            productName
        }
    }
`);

// Compact summary used by the variant relation-input: for both name-search and
// fetching the currently-assigned groups by id (filter.id.in).
export const getAddonGroupSummariesDocument = graphql(`
    query GetAddonGroupSummaries($options: AddonGroupListOptions) {
        addonGroups(options: $options) {
            items {
                id
                name
                selectionType
                isRequired
                enabled
                items {
                    id
                }
            }
            totalItems
        }
    }
`);

export const getActiveChannelCurrencyDocument = graphql(`
    query GetActiveChannelAddonCurrency {
        activeChannel {
            id
            defaultCurrencyCode
        }
    }
`);

export interface AddonItemDto {
    id: string;
    createdAt: string;
    name: string;
    price: number;
    sku: string | null;
    isDefault: boolean;
    minQuantity: number;
    maxQuantity: number;
    sortOrder: number;
    enabled: boolean;
    image: { id: string; preview: string } | null;
}

export interface AddonGroupDto {
    id: string;
    createdAt: string;
    updatedAt: string;
    name: string;
    description: string | null;
    selectionType: 'CHECKBOX' | 'QUANTITY';
    isRequired: boolean;
    minSelections: number;
    maxSelections: number;
    sortOrder: number;
    enabled: boolean;
    items: AddonItemDto[];
}

export const getOrderAddonSelectionsDocument = graphql(`
    query GetOrderAddonSelections($id: ID!) {
        order(id: $id) {
            id
            currencyCode
            addonsTotal
            lines {
                id
                productVariant {
                    name
                }
                addonsAvailable
                addonSelections {
                    groupId
                    groupName
                    selectionType
                    enabled
                    items {
                        itemId
                        itemName
                        quantity
                        unitPrice
                        imageUrl
                        enabled
                    }
                }
            }
        }
    }
`);

export interface AddonSelectionItemDto {
    itemId: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    imageUrl: string | null;
    enabled: boolean;
}

export interface AddonGroupSelectionDto {
    groupId: string;
    groupName: string;
    selectionType: 'CHECKBOX' | 'QUANTITY';
    enabled: boolean;
    items: AddonSelectionItemDto[];
}

export interface OrderLineWithAddonsDto {
    id: string;
    productVariant: { name: string };
    addonsAvailable: boolean;
    addonSelections: AddonGroupSelectionDto[];
}

export interface AddonGroupSummaryDto {
    id: string;
    name: string;
    selectionType: 'CHECKBOX' | 'QUANTITY';
    isRequired: boolean;
    enabled: boolean;
    items: Array<{ id: string }>;
}

export interface AssignedVariantDto {
    id: string;
    name: string;
    sku: string;
    productId: string;
    productName: string;
}
