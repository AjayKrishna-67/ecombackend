import {
    OrderInterceptor,
    RequestContext,
    Order,
    Injector,
    Logger,
} from '@vendure/core';
import { CartValidationService } from '../services/cart-validation.service';
import { CartContainsUnavailableItemsError } from '../cart-validation.plugin';

const loggerCtx = 'CartValidationInterceptor';

/**
 * Order interceptor that validates cart items before allowing checkout
 * Blocks state transition to ArrangingPayment if cart contains unavailable items
 */
export class CartValidationInterceptor implements OrderInterceptor {
    private cartValidationService: CartValidationService;
    
    init(injector: Injector) {
        this.cartValidationService = injector.get(CartValidationService);
    }
    
    /**
     * Hook that runs before order state transitions
     * Validates cart when transitioning from AddingItems to ArrangingPayment
     */
    async preTransition(
        ctx: RequestContext,
        fromState: string,
        toState: string,
        order: Order
    ): Promise<boolean | string | CartContainsUnavailableItemsError> {
        // Only validate when attempting to proceed to checkout
        if (fromState === 'AddingItems' && toState === 'ArrangingPayment') {
            Logger.debug(
                `Validating cart before checkout transition for order ${order.code}`,
                loggerCtx
            );
            
            try {
                const validationResult = await this.cartValidationService.validateOrder(
                    ctx,
                    order
                );
                
                if (!validationResult.isValid) {
                    Logger.info(
                        `Checkout blocked for order ${order.code}: ${validationResult.totalUnavailableItems} unavailable items`,
                        loggerCtx
                    );
                    
                    return new CartContainsUnavailableItemsError(
                        validationResult.unavailableItems
                    );
                }
                
                Logger.debug(
                    `Cart validation passed for order ${order.code}`,
                    loggerCtx
                );
            } catch (error: any) {
                Logger.error(
                    `Error during cart validation for order ${order.code}: ${error.message}`,
                    loggerCtx,
                    error.stack
                );
                // Allow transition on error (fail open) to avoid blocking legitimate checkouts
                return true;
            }
        }
        
        // Allow transition for all other state changes
        return true;
    }
}
