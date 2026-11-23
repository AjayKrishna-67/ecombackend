import { ID } from '@vendure/core';

/**
 * Details about a quantity limit violation
 */
export interface QuantityLimitViolation {
    /**
     * ID of the affected order line
     */
    orderLineId: ID;
    /**
     * Human-readable product name
     */
    productName: string;
    /**
     * Human-readable variant name
     */
    variantName: string;
    /**
     * Current quantity in cart
     */
    currentQuantity: number;
    /**
     * Maximum allowed quantity
     */
    maxQuantity: number;
    /**
     * Maximum quantity the customer can still add to cart
     */
    maxAllowedInCart: number;
    /**
     * Reason message for the violation
     */
    reason: string;
    /**
     * The configured limit start date (ISO string), used for "try again after" messaging
     */
    limitStartDate?: string | null;
}

/**
 * Overall quantity limit validation status for an order
 */
export interface QuantityLimitValidationStatus {
    /**
     * Whether all items are within quantity limits
     */
    isValid: boolean;
    /**
     * Whether order contains any quantity violations
     */
    hasViolations: boolean;
    /**
     * Total count of violations
     */
    totalViolations: number;
    /**
     * Detailed list of violations
     */
    violations: QuantityLimitViolation[];
}

/**
 * Reasons for stock issues
 */
export enum StockIssueReason {
    OUT_OF_STOCK = 'This item is currently out of stock',
    INSUFFICIENT_STOCK = 'Insufficient stock available for the requested quantity',
}

/**
 * Simple stock availability status for an order
 */
export interface StockAvailabilityResult {
    /**
     * Whether all items in the order are available in stock
     */
    isAvailable: boolean;
    /**
     * Reason why items are unavailable (null if all available)
     */
    unavailableReason: string | null;
}
