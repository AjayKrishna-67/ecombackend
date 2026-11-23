import gql from 'graphql-tag';

export const shopApiExtensions = gql`
    type BannerPopup {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        asset: Asset!
        product: Product
        collection: Collection
        productVariant: ProductVariant
    }

    extend type Query {
        allBannerPopup: [BannerPopup!]!
        nextBannerPopup: BannerPopup
    }
`;

const bannerPopupAdminApiExtensions = gql`
  type BannerPopup implements Node {
    id: ID!
    createdAt: DateTime!
    updatedAt: DateTime!
    asset: Asset!
    product: Product
    collection: Collection
    productVariant: ProductVariant
    isPreview: Boolean!
  }

  type BannerPopupList implements PaginatedList {
    items: [BannerPopup!]!
    totalItems: Int!
  }

  input BannerPopupListOptions {
    skip: Int
    take: Int
    sort: BannerPopupSort
  }

  input BannerPopupSort {
    createdAt: SortOrder
    updatedAt: SortOrder
  }

  extend type Query {
    bannerPopup(id: ID!): BannerPopup
    allBannerPopup(options: BannerPopupListOptions): BannerPopupList!
  }

  input CreateBannerPopupInput {
    assetId: ID!
    productId: ID
    collectionId: ID
    productVariantId: ID
    isPreview: Boolean
  }

  input UpdateBannerPopupInput {
    id: ID!
    assetId: ID
    productId: ID
    collectionId: ID
    productVariantId: ID
    isPreview: Boolean
  }

  extend type Mutation {
    createBannerPopup(input: CreateBannerPopupInput!): BannerPopup!
    updateBannerPopup(input: UpdateBannerPopupInput!): BannerPopup!
    deleteBannerPopup(id: ID!): DeletionResponse!
    resetBannerPopupRotation: Int!
  }
`;

export const adminApiExtensions = gql`
  ${bannerPopupAdminApiExtensions}
`;
