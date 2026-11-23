import {
    PluginCommonModule,
    VendurePlugin,
    ErrorResult,
} from '@vendure/core';
import { QuantityLimitViolation } from './types/quantity-limit-types';
import { QuantityLimitInterceptor } from './config/quantity-limit.interceptor';
import { QuantityLimitOrderResolver, StockAvailabilityOrderResolver } from './api/quantity-limit.resolver';
import { shopApiExtensions } from './api/api-extensions';
import { QuantityLimitService } from './services/quantity-limit.service';

/**
 * Error result when quantity limit is exceeded
 */
export class MaxQuantityExceededError extends ErrorResult {
    readonly __typename = 'QuantityLimitError';
    readonly errorCode = 'MAX_QUANTITY_EXCEEDED';

    constructor(
        public maxQuantity: number,
        public requestedQuantity: number,
        public violations?: QuantityLimitViolation[]
    ) {
        super();
        const violationMessages = violations
            ? violations.map(v => v.reason).join('; ')
            : `Max: ${maxQuantity}, Requested: ${requestedQuantity}`;
        Object.defineProperty(this, 'message', {
            value: `Maximum order quantity exceeded. ${violationMessages}`,
            writable: false,
            enumerable: true,
        });
    }
}

/**
 * Error result when order contains items with insufficient stock
 */
export class InsufficientStockError extends ErrorResult {
    readonly __typename = 'CartInsufficientStockError';
    readonly errorCode = 'CART_INSUFFICIENT_STOCK';

    constructor(public reason: string) {
        super();
        Object.defineProperty(this, 'message', {
            value: `Cannot proceed to checkout. ${reason}`,
            writable: false,
            enumerable: true,
        });
    }
}

/**
 * Plugin for enforcing maximum order quantity limits and stock validation
 *
 * This plugin:
 * - Adds a maxOrderQuantity custom field to ProductVariant (configured in vendure-config.ts)
 * - Exposes quantityLimitStatus on Order for real-time quantity limit validation
 * - Exposes stockStatus on Order for real-time stock availability validation
 * - Blocks checkout if any item exceeds its quantity limit or has insufficient stock
 *
 * Usage:
 * 1. Set "Max Order Quantity" on product variants in the admin
 * 2. The Shop API will expose maxOrderQuantity on ProductVariant
 * 3. Query order.quantityLimitStatus to check for quantity violations
 * 4. Query order.stockStatus to check for stock availability issues
 * 5. Checkout will be blocked if limits are exceeded or stock is insufficient
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [QuantityLimitService],
    exports: [QuantityLimitService],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [QuantityLimitOrderResolver, StockAvailabilityOrderResolver],
    },
    compatibility: '^3.6.3',
    configuration: (config) => {
        config.orderOptions.orderInterceptors = config.orderOptions.orderInterceptors || [];
        config.orderOptions.orderInterceptors.push(new QuantityLimitInterceptor());
        return config;
    },
})
export class QuantityLimitPlugin {}
