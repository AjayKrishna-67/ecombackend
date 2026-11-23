import { Injectable } from '@nestjs/common';
import {
    TransactionalConnection,
    Order,
    OrderLine,
    RequestContext,
    Logger,
    ID,
    ProductVariant,
} from '@vendure/core';
import {
    QuantityLimitValidationStatus,
    QuantityLimitViolation,
    StockAvailabilityResult,
} from '../types/quantity-limit-types';

const loggerCtx = 'QuantityLimitService';

// Order states considered as "completed" (customer has paid/authorized payment)
const COMPLETED_ORDER_STATES = [
    'PaymentAuthorized',
    'PaymentSettled',
    'PartiallyShipped',
    'Shipped',
    'PartiallyDelivered',
    'Delivered',
];

type VariantLimitInfo = { maxQuantity: number | null; startDate: Date | null; productName: string };

type CustomerQuantityValidation = {
    isValid: boolean;
    maxQuantity: number | null;
    alreadyOrdered: number;
    remaining: number;
    requiresLogin: boolean;
    productName: string;
    startDate: Date | null;
};

const UNKNOWN_VARIANT_LIMIT: VariantLimitInfo = { maxQuantity: null, startDate: null, productName: 'Unknown' };

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
 * Service for validating order quantity limits per customer
 * Enforces cumulative limits across orders placed since the Limit Start Date
 */
@Injectable()
export class QuantityLimitService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Get the quantity a customer has already ordered of a variant
     * Only counts completed orders placed after the start date
     */
    async getCustomerOrderedQuantity(
        ctx: RequestContext,
        customerId: ID,
        variantId: ID,
        startDate: Date | null
    ): Promise<number> {
        const qb = this.connection
            .getRepository(ctx, OrderLine)
            .createQueryBuilder('orderLine')
            .innerJoin('orderLine.order', 'order')
            .innerJoin('order.customer', 'customer')
            .innerJoin('orderLine.productVariant', 'variant')
            .where('customer.id = :customerId', { customerId })
            .andWhere('variant.id = :variantId', { variantId })
            .andWhere('order.state IN (:...states)', { states: COMPLETED_ORDER_STATES });
        if (startDate) {
            // Strip time component to avoid timezone offset issues
            // Admin sets a date like "Feb 9" but IST→UTC conversion can shift it forward
            const dateOnly = new Date(startDate);
            dateOnly.setUTCHours(0, 0, 0, 0);
            qb.andWhere('order.orderPlacedAt >= :startDate', { startDate: dateOnly });
        }
        const result = await qb
            .select('SUM(orderLine.quantity)', 'totalQuantity')
            .getRawOne();
        const total = parseInt(result?.totalQuantity || '0', 10);
        Logger.debug(
            `Customer ${customerId} has ordered ${total} of variant ${variantId} since ${startDate?.toISOString() || 'beginning'}`,
            loggerCtx
        );
        return total;
    }

    /**
     * Get variant limit info including max quantity and start date
     */
    async getVariantLimitInfo(ctx: RequestContext, variantId: ID): Promise<VariantLimitInfo> {
        return (await this.getVariantLimitInfos(ctx, [variantId])).get(String(variantId)) ?? UNKNOWN_VARIANT_LIMIT;
    }

    /**
     * Limit info for many variants in one query, keyed by String(variantId).
     * A variant with no row is absent from the map.
     */
    private async getVariantLimitInfos(ctx: RequestContext, variantIds: ID[]): Promise<Map<string, VariantLimitInfo>> {
        const infos = new Map<string, VariantLimitInfo>();
        if (variantIds.length === 0) return infos;
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.product', 'product')
            .leftJoinAndSelect('variant.translations', 'variantTranslations')
            .leftJoinAndSelect('product.translations', 'productTranslations')
            .where('variant.id IN (:...variantIds)', { variantIds: [...new Set(variantIds.map(String))] })
            .getMany();
        for (const variant of variants) {
            const customFields = variant.customFields as any;
            const maxQuantity = customFields?.maxOrderQuantity ?? null;
            const startDate = customFields?.maxQuantityStartDate ? new Date(customFields.maxQuantityStartDate) : null;
            const productName = this.getTranslatedName(variant.product, ctx.languageCode) || this.getTranslatedName(variant, ctx.languageCode) || 'This product';
            infos.set(String(variant.id), { maxQuantity, startDate, productName });
        }
        return infos;
    }

    /**
     * Validate if a customer can have the requested quantity of a variant in their cart
     * Checks both current cart quantity and historical orders since the start date
     */
    async validateCustomerQuantity(
        ctx: RequestContext,
        customerId: ID | null,
        variantId: ID,
        requestedNewTotal: number
    ): Promise<CustomerQuantityValidation> {
        const limitInfo = await this.getVariantLimitInfo(ctx, variantId);
        return this.validateAgainstLimit(ctx, customerId, variantId, requestedNewTotal, limitInfo);
    }

    private async validateAgainstLimit(
        ctx: RequestContext,
        customerId: ID | null,
        variantId: ID,
        requestedNewTotal: number,
        limitInfo: VariantLimitInfo,
    ): Promise<CustomerQuantityValidation> {
        if (limitInfo.maxQuantity === null) {
            return {
                isValid: true,
                maxQuantity: null,
                alreadyOrdered: 0,
                remaining: Infinity,
                requiresLogin: false,
                productName: limitInfo.productName,
                startDate: limitInfo.startDate,
            };
        }
        let alreadyOrdered = 0;
        if (customerId) {
            alreadyOrdered = await this.getCustomerOrderedQuantity(
                ctx,
                customerId,
                variantId,
                limitInfo.startDate
            );
        }
        const totalWithNewOrder = alreadyOrdered + requestedNewTotal;
        const maxAllowedInCart = Math.max(0, limitInfo.maxQuantity - alreadyOrdered);
        const isValid = totalWithNewOrder <= limitInfo.maxQuantity;
        Logger.info(
            `[QuantityLimit] Customer ${customerId}: alreadyOrdered=${alreadyOrdered}, cartQuantity=${requestedNewTotal}, total=${totalWithNewOrder}, max=${limitInfo.maxQuantity}, maxAllowedInCart=${maxAllowedInCart}, valid=${isValid}`,
            loggerCtx
        );
        return {
            isValid,
            maxQuantity: limitInfo.maxQuantity,
            alreadyOrdered,
            remaining: maxAllowedInCart,
            requiresLogin: false,
            productName: limitInfo.productName,
            startDate: limitInfo.startDate,
        };
    }

    /**
     * Validate all items in an order for quantity limits
     */
    async validateOrder(ctx: RequestContext, order: Order): Promise<QuantityLimitValidationStatus> {
        Logger.debug(
            `Validating quantity limits for order ${order.code} with ${order.lines.length} items`,
            loggerCtx
        );
        if (order.lines.length === 0) {
            return {
                isValid: true,
                hasViolations: false,
                totalViolations: 0,
                violations: [],
            };
        }
        let customerId = order.customer?.id || null;
        if (!customerId && order.id) {
            const reloadedOrder = await this.connection
                .getRepository(ctx, Order)
                .findOne({
                    where: { id: order.id },
                    relations: ['customer'],
                });
            customerId = reloadedOrder?.customer?.id || null;
            Logger.debug(
                `Reloaded order ${order.code}, customerId: ${customerId}`,
                loggerCtx
            );
        }
        const violations: QuantityLimitViolation[] = [];
        // One query for every line's limit, instead of one per line. Only lines
        // whose variant actually has a limit go on to query order history.
        const limitInfos = await this.getVariantLimitInfos(ctx, order.lines.map(l => l.productVariant.id));
        for (const line of order.lines) {
            const validation = await this.validateAgainstLimit(
                ctx,
                customerId,
                line.productVariant.id,
                line.quantity,
                limitInfos.get(String(line.productVariant.id)) ?? UNKNOWN_VARIANT_LIMIT,
            );
            if (!validation.isValid) {
                const formattedDate = formatStartDate(validation.startDate);
                let reason: string;
                if (validation.remaining === 0) {
                    reason = formattedDate
                        ? `You have reached the maximum purchase limit for ${validation.productName}. This product will be available for purchase again after ${formattedDate}.`
                        : `You have reached the maximum purchase limit for ${validation.productName}.`;
                } else if (validation.alreadyOrdered > 0) {
                    reason = `Maximum quantity for ${validation.productName} is ${validation.maxQuantity}. You have already purchased ${validation.alreadyOrdered} in previous orders. Your cart can only have ${validation.remaining} of this item.`;
                } else {
                    reason = `Maximum quantity for ${validation.productName} is ${validation.maxQuantity}. Your cart can only have ${validation.remaining} of this item.`;
                }
                violations.push({
                    orderLineId: line.id,
                    productName: validation.productName,
                    variantName: validation.productName,
                    currentQuantity: line.quantity,
                    maxQuantity: validation.maxQuantity || 0,
                    maxAllowedInCart: validation.remaining === Infinity ? -1 : validation.remaining,
                    reason,
                    limitStartDate: validation.startDate?.toISOString() || null,
                });
            }
        }
        const validationResult: QuantityLimitValidationStatus = {
            isValid: violations.length === 0,
            hasViolations: violations.length > 0,
            totalViolations: violations.length,
            violations,
        };
        if (!validationResult.isValid) {
            Logger.info(
                `Order ${order.code} quantity limit validation failed: ${validationResult.totalViolations} violations`,
                loggerCtx
            );
        }
        return validationResult;
    }

    /**
     * Check stock availability for all items in an order
     * Returns a simple isAvailable/unavailableReason result
     */
    async checkStockAvailability(ctx: RequestContext, order: Order): Promise<StockAvailabilityResult> {
        Logger.debug(
            `Checking stock availability for order ${order.code} with ${order.lines.length} items`,
            loggerCtx
        );
        if (order.lines.length === 0) {
            return { isAvailable: true, unavailableReason: null };
        }
        const variantIds = order.lines.map(l => l.productVariant.id);
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.stockLevels', 'stockLevel')
            .leftJoinAndSelect('stockLevel.stockLocation', 'stockLocation')
            .leftJoinAndSelect('stockLocation.channels', 'slChannel')
            .leftJoinAndSelect('variant.translations', 'variantTranslations')
            .where('variant.id IN (:...variantIds)', { variantIds })
            .getMany();
        const channelId = ctx.channelId;
        const stockMap = new Map<ID, { saleableStock: number; variantName: string; trackInventory: string }>();
        for (const variant of variants) {
            const variantName = this.getTranslatedName(variant, ctx.languageCode);
            if (variant.trackInventory === 'FALSE') {
                stockMap.set(variant.id, { saleableStock: Infinity, variantName, trackInventory: 'FALSE' });
                continue;
            }
            const channelStockLevels = (variant.stockLevels || []).filter(sl =>
                sl.stockLocation?.channels?.some((c: any) => c.id === channelId)
            );
            const stockOnHand = channelStockLevels.reduce((sum, sl) => sum + (sl.stockOnHand || 0), 0);
            const stockAllocated = channelStockLevels.reduce((sum, sl) => sum + (sl.stockAllocated || 0), 0);
            const saleableStock = stockOnHand - stockAllocated;
            Logger.debug(
                `Variant ${variant.id}: "${variantName}" - channel=${channelId}, onHand=${stockOnHand}, allocated=${stockAllocated}, saleable=${saleableStock}`,
                loggerCtx
            );
            stockMap.set(variant.id, { saleableStock, variantName, trackInventory: variant.trackInventory as string });
        }
        const unavailableItems: string[] = [];
        for (const line of order.lines) {
            const stockInfo = stockMap.get(line.productVariant.id);
            if (!stockInfo) {
                unavailableItems.push('Unknown item is out of stock');
                continue;
            }
            if (stockInfo.saleableStock <= 0) {
                unavailableItems.push(`${stockInfo.variantName} is currently out of stock`);
            } else if (stockInfo.saleableStock < line.quantity) {
                unavailableItems.push(
                    `Only ${stockInfo.saleableStock} available, kindly decrease quantity`
                );
            }
        }
        if (unavailableItems.length > 0) {
            const reason = unavailableItems.join('; ');
            Logger.info(`Order ${order.code} stock check failed: ${reason}`, loggerCtx);
            return { isAvailable: false, unavailableReason: reason };
        }
        return { isAvailable: true, unavailableReason: null };
    }

    /**
     * Get translated name from entity
     */
    private getTranslatedName(entity: any, languageCode: string): string {
        if (!entity) {
            return 'Unknown';
        }
        if (entity.name) {
            return entity.name;
        }
        if (entity.translations && entity.translations.length > 0) {
            const translation = entity.translations.find(
                (t: any) => t.languageCode === languageCode
            );
            if (translation?.name) {
                return translation.name;
            }
            if (entity.translations[0]?.name) {
                return entity.translations[0].name;
            }
        }
        return 'Unknown';
    }
}
