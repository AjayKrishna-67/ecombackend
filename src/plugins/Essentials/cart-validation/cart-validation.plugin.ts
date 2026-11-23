import {
    PluginCommonModule,
    VendurePlugin,
    ErrorResult,
} from '@vendure/core';
import { UnavailableCartItem } from './types/validation-types';
import { CartValidationInterceptor } from './config/cart-validation.interceptor';
import { minimumOrderProcess } from './config/minimum-order.process';
import { CartValidationOrderResolver, CartValidationLineResolver } from './api/cart-validation-entity.resolver';
import { shopApiExtensions } from './api/api-extensions';
import { CartValidationService } from './services/cart-validation.service';
import { AvailabilityVariantDataLoader } from './api/availability-variant.dataloader';

/**
 * Error result when cart contains unavailable items
 */
export class CartContainsUnavailableItemsError extends ErrorResult {
    readonly __typename = 'CartContainsUnavailableItemsError';
    readonly errorCode = 'CART_CONTAINS_UNAVAILABLE_ITEMS';
    
    constructor(public unavailableItems: UnavailableCartItem[]) {
        super();
        // Use Object.defineProperty to set readonly message
        Object.defineProperty(this, 'message', {
            value: `Cannot proceed to checkout. ${unavailableItems.length} item(s) in your cart are no longer available.`,
            writable: false,
            enumerable: true,
        });
    }
}

/**
 * Plugin for validating cart items are available before checkout
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [CartValidationService, AvailabilityVariantDataLoader],
    exports: [CartValidationService],
    shopApiExtensions: {
        schema: shopApiExtensions,
        resolvers: [CartValidationOrderResolver, CartValidationLineResolver],
    },
    compatibility: '^3.6.3',
    configuration: (config) => {
        config.orderOptions.orderInterceptors = config.orderOptions.orderInterceptors || [];
        config.orderOptions.orderInterceptors.push(new CartValidationInterceptor());
        // Channel minimum order value: no checkout below it.
        config.orderOptions.process.push(minimumOrderProcess);
        return config;
    },
})
export class CartValidationPlugin {}
