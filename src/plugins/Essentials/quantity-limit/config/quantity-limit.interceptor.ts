import {
    OrderInterceptor,
    RequestContext,
    Order,
    Injector,
    Logger,
    ProductVariant,
    OrderLine,
} from '@vendure/core';
import { QuantityLimitService } from '../services/quantity-limit.service';
import { MaxQuantityExceededError, InsufficientStockError } from '../quantity-limit.plugin';

const loggerCtx = 'QuantityLimitInterceptor';

interface WillAddItemToOrderInput {
    productVariant: ProductVariant;
    quantity: number;
}

interface WillAdjustOrderLineInput {
    orderLine: OrderLine;
    quantity: number;
}

/**
 * Formats a Date to a human-readable string for error messages
 */
function formatStartDate(date: Date | null): string | null {
    if (!date) return null;
    return date.toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
}

/**
 * Order interceptor that validates quantity limits per customer
 * - Guests can add up to the max quantity (no order history tracked)
 * - Logged-in users: checks cumulative quantity (cart + previous orders since start date) against per-variant limits
 */
export class QuantityLimitInterceptor implements OrderInterceptor {
    private quantityLimitService: QuantityLimitService;

    init(injector: Injector) {
        this.quantityLimitService = injector.get(QuantityLimitService);
    }

    /**
     * Hook that runs before adding an item to the order
     */
    async willAddItemToOrder(
        ctx: RequestContext,
        order: Order,
        input: WillAddItemToOrderInput
    ): Promise<void | string> {
        const maxQtyRaw = (input.productVariant.customFields as any)?.maxOrderQuantity;
        if (maxQtyRaw === null || maxQtyRaw === undefined) {
            return;
        }
        const newQuantity = parseInt(String(input.quantity), 10) || 1;
        const customerId = order.customer?.id || null;
        const validation = await this.quantityLimitService.validateCustomerQuantity(
            ctx,
            customerId,
            input.productVariant.id,
            newQuantity
        );
        if (!validation.isValid) {
            Logger.info(
                `[QuantityLimit] BLOCKED: ${validation.productName} - requesting ${newQuantity}, alreadyOrdered=${validation.alreadyOrdered}, max=${validation.maxQuantity}, remaining=${validation.remaining}`,
                loggerCtx
            );
            if (validation.remaining === 0) {
                const formattedDate = formatStartDate(validation.startDate);
                return formattedDate
                    ? `You have reached the maximum purchase limit for ${validation.productName}. This product will be available for purchase again after ${formattedDate}.`
                    : `You have reached the maximum purchase limit for ${validation.productName}.`;
            }
            if (validation.alreadyOrdered > 0) {
                return `Maximum quantity for ${validation.productName} is ${validation.maxQuantity}. You have already purchased ${validation.alreadyOrdered} in previous orders. Your cart can only have ${validation.remaining} of this item.`;
            }
            return `Maximum quantity for ${validation.productName} is ${validation.maxQuantity}. Your cart can only have ${validation.remaining} of this item.`;
        }
        Logger.info(
            `[QuantityLimit] ALLOWED: ${validation.productName} - cart=${newQuantity}, max=${validation.maxQuantity}, remaining=${validation.remaining}`,
            loggerCtx
        );
    }

    /**
     * Hook that runs before adjusting an order line quantity
     */
    async willAdjustOrderLine(
        ctx: RequestContext,
        order: Order,
        input: WillAdjustOrderLineInput
    ): Promise<void | string> {
        const maxQtyRaw = (input.orderLine.productVariant?.customFields as any)?.maxOrderQuantity;
        if (maxQtyRaw === null || maxQtyRaw === undefined) {
            return;
        }
        const requestedQuantity = parseInt(String(input.quantity), 10);
        const currentQuantity = input.orderLine.quantity;
        // Always allow decreasing quantity - no need to validate
        if (requestedQuantity <= currentQuantity) {
            Logger.info(
                `[QuantityLimit] ALLOWED decrease: ${input.orderLine.productVariant?.id} from ${currentQuantity} to ${requestedQuantity}`,
                loggerCtx
            );
            return;
        }
        const customerId = order.customer?.id || null;
        const variantId = input.orderLine.productVariant?.id;
        if (!variantId) {
            return;
        }
        const validation = await this.quantityLimitService.validateCustomerQuantity(
            ctx,
            customerId,
            variantId,
            requestedQuantity
        );
        if (!validation.isValid) {
            Logger.info(
                `[QuantityLimit] BLOCKED adjust: ${validation.productName} - requesting ${requestedQuantity}, alreadyOrdered=${validation.alreadyOrdered}, max=${validation.maxQuantity}, remaining=${validation.remaining}`,
                loggerCtx
            );
            if (validation.remaining === 0) {
                const formattedDate = formatStartDate(validation.startDate);
                return formattedDate
                    ? `You have reached the maximum purchase limit for ${validation.productName}. This product will be available for purchase again after ${formattedDate}.`
                    : `You have reached the maximum purchase limit for ${validation.productName}.`;
            }
            if (validation.alreadyOrdered > 0) {
                return `Maximum quantity for ${validation.productName} is ${validation.maxQuantity}. You have already purchased ${validation.alreadyOrdered} in previous orders. Your cart can only have ${validation.remaining} of this item.`;
            }
            return `Maximum quantity for ${validation.productName} is ${validation.maxQuantity}. Your cart can only have ${validation.remaining} of this item.`;
        }
    }

    /**
     * Hook that runs before order state transitions
     * Validates quantity limits when transitioning from AddingItems to ArrangingPayment
     */
    async preTransition(
        ctx: RequestContext,
        fromState: string,
        toState: string,
        order: Order
    ): Promise<boolean | string | MaxQuantityExceededError | InsufficientStockError> {
        if (fromState === 'AddingItems' && toState === 'ArrangingPayment') {
            // Quantity limit validation
            Logger.debug(
                `Validating quantity limits before checkout for order ${order.code}`,
                loggerCtx
            );
            try {
                const validationResult = await this.quantityLimitService.validateOrder(
                    ctx,
                    order
                );
                if (!validationResult.isValid) {
                    Logger.info(
                        `Checkout blocked for order ${order.code}: ${validationResult.totalViolations} quantity limit violations`,
                        loggerCtx
                    );
                    const firstViolation = validationResult.violations[0];
                    return new MaxQuantityExceededError(
                        firstViolation.maxQuantity,
                        firstViolation.currentQuantity,
                        validationResult.violations
                    );
                }
                Logger.debug(
                    `Quantity limit validation passed for order ${order.code}`,
                    loggerCtx
                );
            } catch (error: any) {
                Logger.error(
                    `Error during quantity limit validation for order ${order.code}: ${error.message}`,
                    loggerCtx,
                    error.stack
                );
                return true;
            }
            // Stock availability validation
            Logger.debug(
                `Validating stock before checkout for order ${order.code}`,
                loggerCtx
            );
            try {
                const stockResult = await this.quantityLimitService.checkStockAvailability(
                    ctx,
                    order
                );
                if (!stockResult.isAvailable) {
                    Logger.info(
                        `Checkout blocked for order ${order.code}: ${stockResult.unavailableReason}`,
                        loggerCtx
                    );
                    return new InsufficientStockError(
                        stockResult.unavailableReason || 'Some items in your cart are out of stock'
                    );
                }
                Logger.debug(
                    `Stock validation passed for order ${order.code}`,
                    loggerCtx
                );
            } catch (error: any) {
                Logger.error(
                    `Error during stock validation for order ${order.code}: ${error.message}`,
                    loggerCtx,
                    error.stack
                );
                return true;
            }
        }
        return true;
    }
}
