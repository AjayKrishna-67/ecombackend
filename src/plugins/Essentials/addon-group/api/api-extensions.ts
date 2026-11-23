import gql from 'graphql-tag';

const commonTypes = gql`
    enum AddonSelectionType {
        CHECKBOX
        QUANTITY
    }

    type AddonItem implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        name: String!
        price: Money!
        sku: String
        isDefault: Boolean!
        minQuantity: Int!
        maxQuantity: Int!
        sortOrder: Int!
        enabled: Boolean!
        image: Asset
    }

    type AddonGroup implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        name: String!
        description: String
        selectionType: AddonSelectionType!
        isRequired: Boolean!
        minSelections: Int!
        maxSelections: Int!
        sortOrder: Int!
        enabled: Boolean!
        items: [AddonItem!]!
        channels: [Channel!]!
    }

    type AddonSelectionItem {
        itemId: ID!
        itemName: String!
        quantity: Int!
        unitPrice: Money!
        imageUrl: String
        "False if the addon item (or its group) is currently disabled or deleted; storefront should show the chip as disabled."
        enabled: Boolean!
    }

    type AddonGroupSelection {
        groupId: ID!
        groupName: String!
        selectionType: AddonSelectionType!
        items: [AddonSelectionItem!]!
        "False if the addon group is currently disabled or deleted; storefront should show the group as disabled."
        enabled: Boolean!
    }
`;

export const adminApiExtensions = gql`
    ${commonTypes}

    type AddonGroupList implements PaginatedList {
        items: [AddonGroup!]!
        totalItems: Int!
    }

    input AddonGroupListOptions {
        skip: Int
        take: Int
        sort: AddonGroupSortParameter
        filter: AddonGroupFilterParameter
    }

    input AddonGroupSortParameter {
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        name: SortOrder
        sortOrder: SortOrder
    }

    input AddonGroupFilterParameter {
        id: IDOperators
        createdAt: DateOperators
        updatedAt: DateOperators
        name: StringOperators
        enabled: BooleanOperators
    }

    input CreateAddonGroupInput {
        name: String!
        description: String
        selectionType: AddonSelectionType
        isRequired: Boolean
        minSelections: Int
        maxSelections: Int
        sortOrder: Int
        enabled: Boolean
    }

    input UpdateAddonGroupInput {
        id: ID!
        name: String
        description: String
        selectionType: AddonSelectionType
        isRequired: Boolean
        minSelections: Int
        maxSelections: Int
        sortOrder: Int
        enabled: Boolean
    }

    input CreateAddonItemInput {
        groupId: ID!
        name: String!
        price: Int
        sku: String
        isDefault: Boolean
        minQuantity: Int
        maxQuantity: Int
        sortOrder: Int
        enabled: Boolean
        imageId: ID
    }

    input UpdateAddonItemInput {
        id: ID!
        name: String
        price: Int
        sku: String
        isDefault: Boolean
        minQuantity: Int
        maxQuantity: Int
        sortOrder: Int
        enabled: Boolean
        imageId: ID
    }

    type AddonGroupAssignedVariant {
        id: ID!
        name: String!
        sku: String!
        productId: ID!
        productName: String!
    }

    input AssignAddonGroupsToChannelInput {
        addonGroupIds: [ID!]!
        channelId: ID!
    }

    input RemoveAddonGroupsFromChannelInput {
        addonGroupIds: [ID!]!
        channelId: ID!
    }

    extend type Query {
        addonGroup(id: ID!): AddonGroup
        addonGroups(options: AddonGroupListOptions): AddonGroupList!
        variantsWithAddonGroup(addonGroupId: ID!): [AddonGroupAssignedVariant!]!
    }

    extend type Mutation {
        createAddonGroup(input: CreateAddonGroupInput!): AddonGroup!
        updateAddonGroup(input: UpdateAddonGroupInput!): AddonGroup!
        deleteAddonGroup(id: ID!): DeletionResponse!
        createAddonItem(input: CreateAddonItemInput!): AddonItem!
        updateAddonItem(input: UpdateAddonItemInput!): AddonItem!
        deleteAddonItem(id: ID!): DeletionResponse!
        assignAddonGroupsToChannel(input: AssignAddonGroupsToChannelInput!): [AddonGroup!]!
        removeAddonGroupsFromChannel(input: RemoveAddonGroupsFromChannelInput!): [AddonGroup!]!
        recomputeAddonSurcharges(orderId: ID!): Boolean!
    }

    extend type OrderLine {
        addonSelections: [AddonGroupSelection!]!
        priceWithAddons: Money!
        "False if any addon (group or item) on this line is currently disabled or deleted; storefront should render the whole line as out of stock."
        addonsAvailable: Boolean!
    }

    extend type Order {
        addonsTotal: Money!
    }
`;

export const shopApiExtensions = gql`
    ${commonTypes}

    input AddonItemSelectionInput {
        addonItemId: ID!
        quantity: Int!
    }

    input AddonGroupSelectionInput {
        addonGroupId: ID!
        items: [AddonItemSelectionInput!]!
    }

    input AddAddonsToOrderLineInput {
        orderLineId: ID!
        selections: [AddonGroupSelectionInput!]!
    }

    extend type Query {
        addonGroupsForVariant(productVariantId: ID!): [AddonGroup!]!
    }

    extend type Mutation {
        addAddonsToOrderLine(input: AddAddonsToOrderLineInput!): Order!
    }

    extend type OrderLine {
        addonSelections: [AddonGroupSelection!]!
        priceWithAddons: Money!
        "False if any addon (group or item) on this line is currently disabled or deleted; storefront should render the whole line as out of stock."
        addonsAvailable: Boolean!
    }

    extend type Order {
        addonsTotal: Money!
    }
`;
