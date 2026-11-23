import { gql } from 'graphql-tag';

export const shopApiExtensions = gql`
  extend type Mutation {
    """
    Allows a customer to request cancellation for their order.
    The reason string can be any text or JSON sent from the client.
    """
    requestOrderCancellation(orderId: ID!, reason: String!): Order!

    """
    Add other instructions to the order custom fields
    """
    otherInstructions(orderId: ID!, value: String!): Order!
  }
`;