import { gql } from 'graphql-tag';

export const shopApiExtensions = gql`
  extend type Query {
    frequentlyOrderedProducts: [FrequentlyOrderedProduct!]!
  }

  type FrequentlyOrderedProduct {
    product: Product!
    orderCount: Int!
  }
`;

export const adminApiExtensions = gql`
  type ProductSalesStats {
    productId: ID!
    productName: String!
    totalOrders: Int!
    totalQuantity: Int!
  }

  extend type Query {
    productSalesGraph: [ProductSalesStats!]!
  }
`;