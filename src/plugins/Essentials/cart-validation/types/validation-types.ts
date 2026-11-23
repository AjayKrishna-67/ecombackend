import { ID } from '@vendure/core';

/**
 * Overall validation status for a shopping cart
 */
export interface CartValidationStatus {
    /**
     * Whether all items in the cart are available for purchase
     */
    isValid: boolean;
    
    /**
     * Whether cart contains any unavailable items
     */
    hasUnavailableItems: boolean;
    
    /**
     * Total count of unavailable items
     */
    totalUnavailableItems: number;
    
    /**
     * Detailed list of unavailable items
     */
    unavailableItems: UnavailableCartItem[];

    /**
     * Overall validation message (e.g. product-level stock summary)
     */
    message?: string | null;

    /** Whether the product total reaches the channel's minimum order value. */
    meetsMinimumOrder: boolean;

    /** The channel's minimum order value in paise; null when it has none. */
    minimumOrderAmount: number | null;

    /** How much more (paise) the cart needs to reach the minimum; 0 when met. */
    amountToMinimumOrder: number;

    /** What to tell the customer while below the minimum; null when met. */
    minimumOrderMessage: string | null;
}

/**
 * Details about a specific unavailable cart item
 */
export interface UnavailableCartItem {
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
     * Reason why item is unavailable
     */
    reason: string;
}

/**
 * Enum for unavailability reasons
 */
export enum UnavailabilityReason {
    PRODUCT_DISABLED = 'Product has been disabled',
    VARIANT_DISABLED = 'This variant is no longer available',
    BOTH_DISABLED = 'Product and variant have been disabled',
    PRODUCT_REMOVED = 'This product has been removed and is no longer available',
}

