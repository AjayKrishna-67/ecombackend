import { RequestContext, ProductVariant, Order, idsAreEqual } from '@vendure/core';
import { OrderItemPriceCalculationStrategy } from '@vendure/core';

interface PriceCalculationResult {
    price: number;
    priceIncludesTax: boolean;
}

/**
 * Price lock: once the customer has tapped Pay (ArrangingPayment) the Razorpay
 * amount is fixed, so each line keeps the price it already has. Vendure core
 * re-runs this strategy for every line whenever the address, coupon or loyalty
 * points change (OrderService.applyPriceAdjustments has no state check), so this
 * is the one place that covers all of those paths. Lines are matched on variant +
 * addon selections, which is how Vendure merges lines, so the match is unique.
 */
function findLockedLinePrice(
    productVariant: ProductVariant,
    orderLineCustomFields: { [key: string]: any },
    order: Order,
): PriceCalculationResult | undefined {
    if (order?.state !== 'ArrangingPayment') {
        return undefined;
    }
    const addonSelections = orderLineCustomFields?.addonSelections ?? null;
    const line = order.lines?.find(
        l =>
            idsAreEqual(l.productVariantId ?? l.productVariant?.id, productVariant.id) &&
            ((l.customFields as any)?.addonSelections ?? null) === addonSelections,
    );
    if (line?.listPrice == null) {
        return undefined;
    }
    return { price: line.listPrice, priceIncludesTax: line.listPriceIncludesTax };
}

/**
 * Extends the default price calculation to include addon selections.
 * When an OrderLine has addonSelections in its custom fields, the addon
 * prices are added to the unit price so they appear in the subtotal.
 */
export class AddonPriceCalculationStrategy implements OrderItemPriceCalculationStrategy {
    calculateUnitPrice(
        ctx: RequestContext,
        productVariant: ProductVariant,
        orderLineCustomFields: { [key: string]: any },
        order: Order,
        quantity: number,
    ): PriceCalculationResult {
        const lockedPrice = findLockedLinePrice(productVariant, orderLineCustomFields, order);
        if (lockedPrice) {
            return lockedPrice;
        }
        let price = productVariant.listPrice;
        const priceIncludesTax = productVariant.listPriceIncludesTax;
        const addonSelectionsJson = orderLineCustomFields?.addonSelections;
        if (addonSelectionsJson) {
            try {
                const selections: Array<{
                    items: Array<{ unitPrice: number; quantity: number }>;
                }> = JSON.parse(addonSelectionsJson);
                for (const group of selections) {
                    for (const item of group.items) {
                        price += item.unitPrice * item.quantity;
                    }
                }
            } catch {
                // Invalid JSON — ignore addon pricing
            }
        }
        return { price, priceIncludesTax };
    }
}
