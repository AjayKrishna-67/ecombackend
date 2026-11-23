import { gql } from 'graphql-tag';

/**
 * GraphQL schema extensions for cart validation
 */
export const shopApiExtensions = gql`
    extend type Order {
        validationStatus: CartValidationStatus!
    }
    
    extend type OrderLine {
        isAvailable: Boolean!
        unavailableReason: String
    }
    
    type CartValidationStatus {
        isValid: Boolean!
        hasUnavailableItems: Boolean!
        totalUnavailableItems: Int!
        unavailableItems: [UnavailableCartItem!]!
        message: String
        """
        Whether the cart's product total (after discounts, before delivery
        charges) reaches the channel's minimum order value. Checkout (the move
        to ArrangingPayment) is refused while false.
        """
        meetsMinimumOrder: Boolean!
        """The channel's minimum order value; null when it has none."""
        minimumOrderAmount: Money
        """How much more the cart needs to reach the minimum; 0 when met."""
        amountToMinimumOrder: Money!
        """What to tell the customer while below the minimum; null when met."""
        minimumOrderMessage: String
    }
    
    type UnavailableCartItem {
        orderLineId: ID!
        productName: String!
        variantName: String!
        reason: String!
    }
    
    type CartContainsUnavailableItemsError implements ErrorResult {
        errorCode: ErrorCode!
        message: String!
        unavailableItems: [UnavailableCartItem!]!
    }
    
    extend union TransitionOrderToStateResult = CartContainsUnavailableItemsError
`;
