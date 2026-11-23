import {
    Injector,
    LanguageCode,
    Logger,
    ShippingCalculator,
    RequestContext,
    Order,
    TransactionalConnection,
} from '@vendure/core';

import { resolveVariantMeasures } from '../../../Stock/shared/resolve-variant-measure';

const loggerCtx = 'WeightBasedShippingCalculator';

let connection: TransactionalConnection;

export const weightBasedShippingCalculator = new ShippingCalculator({
    code: 'weight-based-calculator',
    description: [{ languageCode: LanguageCode.en, value: 'Weight-based shipping calculator' }],
    args: {
        weightThreshold: {
            type: 'int',
            label: [{ languageCode: LanguageCode.en, value: 'Weight Threshold (grams)' }],
            description: [{ 
                languageCode: LanguageCode.en, 
                value: 'The weight threshold in grams (e.g., 100 for 100g = ₹10)' 
            }],
            required: true,
        },
        costPerThreshold: {
            type: 'float',
            label: [{ languageCode: LanguageCode.en, value: 'Cost per Threshold' }],
            description: [{ 
                languageCode: LanguageCode.en, 
                value: 'The shipping cost for the weight threshold in main currency unit (e.g., 10 for ₹10.00, 0.10 for ₹0.10)' 
            }],
            required: true,
        },
        grossAmount: {
            type: 'float',
            label: [{ languageCode: LanguageCode.en, value: 'Gross Amount (Base Shipping)' }],
            description: [{ 
                languageCode: LanguageCode.en, 
                value: 'Base/gross shipping amount added to the weight-based cost (e.g., 50 for ₹50.00, 0 for no base charge)' 
            }],
            required: false,
        },
    },

    init: (injector: Injector) => {
        connection = injector.get(TransactionalConnection);
    },

    calculate: async (ctx: RequestContext, order: Order, args: { weightThreshold: number; costPerThreshold: number; grossAmount?: number }) => {
        // Convert costPerThreshold from currency units to cents/paisa
        // e.g., 10.00 -> 1000 cents, 0.10 -> 10 cents
        const costPerThresholdInCents = Math.round(args.costPerThreshold * 100);
        // Convert grossAmount from currency units to cents/paisa (default to 0 if not provided)
        const grossAmountInCents = Math.round((args.grossAmount || 0) * 100);
        try {
            // Calculate total weight from all order lines
            let totalWeight = 0;

            // Weight comes from the variant's option (measureValue +
            // measureUnit). Batched: one query for the whole order.
            let measures = new Map<string, { grams: number | null }>();
            try {
                measures = new Map(
                    await resolveVariantMeasures(
                        ctx,
                        connection,
                        order.lines.map(l => l.productVariant).filter(Boolean),
                    ),
                );
            } catch (loadError) {
                Logger.warn(`Failed to resolve variant weights: ${loadError}`, loggerCtx);
            }

            for (const line of order.lines) {
                const variantWeight = measures.get(String(line.productVariant.id))?.grams || 0;

                const lineWeight = variantWeight * line.quantity;
                totalWeight += lineWeight;
                
                if (variantWeight === 0) {
                    Logger.warn(
                        `No weight found for product variant ${line.productVariant.id} in order ${order.id}`,
                        loggerCtx
                    );
                }
            }

            // If no weight found, return zero cost
            if (totalWeight === 0) {
                Logger.warn(`No weight found for order ${order.id}, returning zero shipping cost`, loggerCtx);
                return { 
                    price: 0, 
                    priceIncludesTax: ctx.channel.pricesIncludeTax, 
                    taxRate: 0,
                    metadata: { 
                        totalWeight: 0,
                        weightThreshold: args.weightThreshold,
                        costPerThreshold: costPerThresholdInCents,
                        grossAmount: grossAmountInCents,
                    }
                };
            }

            // Calculate shipping cost based on weight
            // Formula: grossAmount + ((totalWeight / weightThreshold) * costPerThreshold)
            // Round up to ensure we charge for partial thresholds
            const numberOfThresholds = Math.ceil(totalWeight / args.weightThreshold);
            const weightBasedCost = numberOfThresholds * costPerThresholdInCents;
            const shippingCost = grossAmountInCents + weightBasedCost;

            Logger.info(
                `Calculated shipping cost for order ${order.id}: ${totalWeight}g total weight, ` +
                `Gross: ₹${(grossAmountInCents / 100).toFixed(2)} + ` +
                `${numberOfThresholds} threshold(s) × ₹${args.costPerThreshold} = ₹${(shippingCost / 100).toFixed(2)} (${shippingCost} cents)`,
                loggerCtx
            );

            return {
                price: shippingCost,
                priceIncludesTax: ctx.channel.pricesIncludeTax,
                taxRate: 0,
                metadata: {
                    totalWeight,
                    weightThreshold: args.weightThreshold,
                    costPerThreshold: costPerThresholdInCents,
                    grossAmount: grossAmountInCents,
                    numberOfThresholds,
                    weightBasedCost: weightBasedCost,
                },
            };

        } catch (error: any) {
            Logger.error(
                `Weight-based shipping calculation failed for order ${order.id}: ${error.message}`,
                loggerCtx,
                error.stack
            );
            return { 
                price: 0, 
                priceIncludesTax: ctx.channel.pricesIncludeTax, 
                taxRate: 0,
                metadata: { error: true }
            };
        }
    },
});

