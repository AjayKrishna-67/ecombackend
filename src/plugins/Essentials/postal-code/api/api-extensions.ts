import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type PostalCodeArea implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        name: String!
        enabled: Boolean!
        postalCode: PostalCode
    }

    type PostalCode implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        code: String!
        isAnywhere: Boolean!
        channels: [Channel!]!
        areas: [PostalCodeArea!]!
    }

    type PostalCodeList implements PaginatedList {
        items: [PostalCode!]!
        totalItems: Int!
    }

    input PostalCodeListOptions {
        skip: Int
        take: Int
        filter: PostalCodeFilter
        sort: PostalCodeSort
        channelId: ID
    }

    input PostalCodeFilter {
        channels: [ID!]
        isAnywhere: Boolean
    }

    input PostalCodeSort {
        createdAt: SortOrder
        updatedAt: SortOrder
        code: SortOrder
    }

    extend type Query {
        postalCode(id: ID!): PostalCode
        postalCodes(options: PostalCodeListOptions): PostalCodeList!
        postalCodeAreas(postalCodeId: ID): [PostalCodeArea!]!
    }

    input CreatePostalCodeInput {
        code: String!
        isAnywhere: Boolean
    }

    input UpdatePostalCodeInput {
        id: ID!
        code: String
        isAnywhere: Boolean
    }

    input CreatePostalCodeAreaInput {
        postalCodeId: ID!
        name: String!
    }

    input UpdatePostalCodeAreaInput {
        id: ID!
        name: String
        enabled: Boolean
    }

    extend type Mutation {
        createPostalCode(input: CreatePostalCodeInput!): PostalCode!
        updatePostalCode(input: UpdatePostalCodeInput!): PostalCode!
        deletePostalCode(id: ID!): DeletionResponse!
        createPostalCodeArea(input: CreatePostalCodeAreaInput!): PostalCodeArea!
        updatePostalCodeArea(input: UpdatePostalCodeAreaInput!): PostalCodeArea!
        deletePostalCodeArea(id: ID!): DeletionResponse!
    }
`;

export const shopApiExtensions = gql`
    type PostalCodeArea {
        id: ID!
        name: String!
        enabled: Boolean!
    }

    type PostalCode {
        id: ID!
        code: String!
        isAnywhere: Boolean!
        areas: [PostalCodeArea!]!
    }

    extend type Query {
        postalCodes: [PostalCode!]!
        """Returns available areas for a given postal code. Empty if code not found or in anywhere mode."""
        areasForPostalCode(code: String!): [PostalCodeArea!]!
    }
`;
