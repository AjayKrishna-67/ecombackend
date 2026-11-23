import { gql } from 'graphql-tag';

/**
 * GraphQL schema extensions for quantity limit validation
 */
export const shopApiExtensions = gql`
    type QuantityLimitViolation {
        orderLineId: ID!
        productName: String!
        variantName: String!
        currentQuantity: Int!
        maxQuantity: Int!
        maxAllowedInCart: Int!
        reason: String!
        limitStartDate: String
    }

    type QuantityLimitValidationStatus {
        isValid: Boolean!
        hasViolations: Boolean!
        totalViolations: Int!
        violations: [QuantityLimitViolation!]!
    }

    extend type Order {
        quantityLimitStatus: QuantityLimitValidationStatus!
    }

    type QuantityLimitError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
        maxQuantity: Int!
        requestedQuantity: Int!
    }

    extend union TransitionOrderToStateResult = QuantityLimitError

    extend type Order {
        isAvailable: Boolean!
        unavailableReason: String
    }

    type CartInsufficientStockError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
    }

    extend union TransitionOrderToStateResult = CartInsufficientStockError
`;
