import gql from 'graphql-tag';

export const commonApiExtensions = gql`
    enum LoyaltyTransactionType {
        USED_ON_ORDER
        EARNED_ON_ORDER
        ORDER_CANCELLED
        ADMINISTRATOR_ADJUSTED
        OTHER
    }

    type LoyaltyPointsTransaction implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        type: LoyaltyTransactionType!
        note: String!
        value: Int!
        order: Order
    }

    type LoyaltyPointsTransactionList implements PaginatedList {
        items: [LoyaltyPointsTransaction!]!
        totalItems: Int!
    }

    type LoyaltyPointsConfig {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        rupeesPerPoint: Int!
        pointsPerRupee: Int!
        channels: [Channel!]!
    }

    extend type Customer {
        loyaltyPointsTransactions(options: LoyaltyPointsTransactionListOptions): LoyaltyPointsTransactionList!
    }

    # Auto-generated at runtime
    input LoyaltyPointsTransactionListOptions
`;

export const adminApiExtensions = gql`
    ${commonApiExtensions}

    input LoyaltyPointsTransactionInput {
        customerId: ID!
        note: String!
        value: Int!
    }

    input LoyaltyPointsConfigInput {
        rupeesPerPoint: Int!
        pointsPerRupee: Int!
        channelIds: [ID!]!
    }

    extend type Query {
        loyaltyPointsConfig: LoyaltyPointsConfig
    }

    extend type Mutation {
        createLoyaltyPointsTransaction(input: LoyaltyPointsTransactionInput!): LoyaltyPointsTransaction!
        createLoyaltyPointsConfig(input: LoyaltyPointsConfigInput!): LoyaltyPointsConfig!
        updateLoyaltyPointsConfig(id: ID!, input: LoyaltyPointsConfigInput!): LoyaltyPointsConfig!
        deleteLoyaltyPointsConfig(id: ID!): Boolean!
    }
`;

export const shopApiExtensions = gql`
    ${commonApiExtensions}

    extend type Query {
        loyaltyPointsConfig: LoyaltyPointsConfig
    }

    extend type Mutation {
        applyLoyaltyPointsToActiveOrder(amount: Int!): Order!
        removeLoyaltyPointsFromActiveOrder: Order
    }
`;