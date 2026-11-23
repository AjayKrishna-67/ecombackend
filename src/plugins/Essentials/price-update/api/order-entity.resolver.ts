import { Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { Order, RequestContext, Ctx, Logger, OrderLine, OrderService, TransactionalConnection, ProductVariant } from '@vendure/core';
import { lockOrderAndReadState, REPRICEABLE_STATE } from '../services/price-lock.util';

const loggerCtx = 'PriceUpdateOrderResolver';

/**
 * Sum of `unitPrice × quantity` across every selection in an OrderLine's
 * `addonSelections` JSON snapshot. Returns 0 when the snapshot is missing or
 * unparseable. Kept in sync with the helper in `price-update.plugin.ts` —
 * both call sites need to be addon-aware so addon-baked listPrices aren't
 * reset to the bare variant price on read.
 */
function getAddonContributionPerUnit(addonSelectionsJson: unknown): number {
    if (typeof addonSelectionsJson !== 'string' || addonSelectionsJson.length === 0) return 0;
    try {
        const groups: Array<{ items?: Array<{ quantity?: number; unitPrice?: number }> }> = JSON.parse(addonSelectionsJson);
        if (!Array.isArray(groups)) return 0;
        let total = 0;
        for (const g of groups) {
            for (const item of g.items || []) {
                total += (item.quantity || 0) * (item.unitPrice || 0);
            }
        }
        return total;
    } catch {
        return 0;
    }
}

/**
 * Order Entity Resolver that updates prices when Order is resolved
 *
 * This hooks into Order.lines resolution and updates prices before returning
 */
@Resolver('Order')
export class PriceUpdateOrderEntityResolver {
    private priceUpdateChecked = new WeakMap<Order, boolean>();

    constructor(
        private orderService: OrderService,
        private connection: TransactionalConnection,
    ) {}

    /**
     * Resolve lines field - this is always queried when getting activeOrder
     * Updates prices once per order resolution
     */
    @ResolveField()
    async lines(@Ctx() ctx: RequestContext, @Parent() order: Order): Promise<OrderLine[]> {
        // Shop API only: this is the live-shopper self-heal path. Repricing on the
        // Admin API would re-run a write for every order in an admin list view (N
        // orders → N reprice passes) and can pick a nondeterministic channel (W5).
        // Only active carts (price lock: an order being paid keeps its price), only
        // once per resolution.
        if (ctx.apiType === 'shop' && order && order.active && order.state === REPRICEABLE_STATE && !this.priceUpdateChecked.get(order)) {
            this.priceUpdateChecked.set(order, true);
            
            try {
                // Check for price changes and update inline
                const result = await this.updatePricesInline(ctx, order);
                
                if (result && result.updated) {
                    Logger.info(
                        `✅ [${order.code}] Updated ${result.changedCount} price(s)`,
                        loggerCtx
                    );
                    return result.order.lines;
                }
            } catch (error: any) {
                Logger.error(
                    `❌ [${order.code}] Price update failed: ${error.message}`,
                    loggerCtx
                );
            }
        }
        
        return order.lines;
    }

    /**
     * Inline price update logic (duplicated from PriceUpdateService)
     * This avoids dependency injection issues
     */
    private async updatePricesInline(
        ctx: RequestContext, 
        order: Order
    ): Promise<{ order: Order; updated: boolean; changedCount: number } | null> {
        try {
            // Load order with relations
            const fullOrder = await this.orderService.findOne(ctx, order.id, [
                'lines',
                'lines.productVariant',
                'channels',
            ]);

            if (!fullOrder || !fullOrder.active || fullOrder.state !== REPRICEABLE_STATE) {
                return null;
            }

            const variantIds = fullOrder.lines.map(line => line.productVariant.id);
            if (variantIds.length === 0) {
                return { order: fullOrder, updated: false, changedCount: 0 };
            }

            // Get current prices from ProductVariant
            const variants = await this.connection
                .getRepository(ctx, ProductVariant)
                .createQueryBuilder('variant')
                .leftJoinAndSelect('variant.productVariantPrices', 'prices')
                .where('variant.id IN (:...variantIds)', { variantIds })
                .getMany();

            const variantPrices: Record<string, number> = {};
            let hasChanges = false;

            for (const variant of variants) {
                const orderLine = fullOrder.lines.find(l => l.productVariant.id === variant.id);
                if (!orderLine) continue;

                // Find price for the current channel
                const channelPrice = variant.productVariantPrices?.find(
                    p => (p as any).channelId === ctx.channelId
                );
                
                // Null-check the ROW, not the number: a legit ₹0 channel price must win (W1).
                const currentPrice = channelPrice ? channelPrice.price : variant.price;
                const orderPrice = orderLine.unitPrice;

                // Addon-aware: the line's price is `variantPrice + addon contribution`
                // when the line has an addonSelections snapshot. Compare against that
                // total — otherwise every read flags the line as "wrong" and resets
                // its listPrice back to the bare variant price, stripping the addons.
                const addonContribution = getAddonContributionPerUnit(
                    (orderLine.customFields as any)?.addonSelections,
                );
                const expectedListPrice = currentPrice + addonContribution;

                if (expectedListPrice !== orderPrice) {
                    variantPrices[variant.id] = currentPrice;
                    hasChanges = true;
                }
            }

            if (!hasChanges) {
                return { order: fullOrder, updated: false, changedCount: 0 };
            }

            // Reprice in the shopper's own request context: it is the order's city
            // channel with its tax zone loaded. A context hand-built from
            // fullOrder.channels[0] had no tax zone (every recalculation threw
            // no-active-tax-zone) and could be the Default channel (master price).
            const orderCtx = ctx;

            const updates = fullOrder.lines
                .filter((line) => variantPrices[line.productVariant.id] !== undefined)
                .map((line) => {
                    const baseNewPrice = variantPrices[line.productVariant.id];
                    const addonContribution = getAddonContributionPerUnit(
                        (line.customFields as any)?.addonSelections,
                    );
                    return {
                        orderLineId: line.id,
                        newPrice: baseNewPrice + addonContribution,
                    };
                });

            if (updates.length > 0) {
                // Bulk UPDATE
                const whenCases = updates
                    .map((u) => `WHEN ${u.orderLineId} THEN ${u.newPrice}`)
                    .join(' ');

                const orderLineIds = updates.map(u => u.orderLineId);

                // Write + recalculate in one transaction behind the order row lock,
                // re-checking the state: the customer may have tapped Pay since the
                // read above (price lock).
                try {
                    const isWritten = await this.connection.withTransaction(orderCtx, async txCtx => {
                        if ((await lockOrderAndReadState(this.connection, txCtx, fullOrder.id)) !== REPRICEABLE_STATE) {
                            return false;
                        }
                        await this.connection
                            .getRepository(txCtx, OrderLine)
                            .createQueryBuilder()
                            .update()
                            .set({
                                listPrice: () => `CASE id ${whenCases} END`
                            })
                            .where('id IN (:...orderLineIds)', { orderLineIds })
                            .andWhere('orderId = :orderId', { orderId: fullOrder.id })
                            .execute();
                        // Recalculate order totals
                        const updatedOrder = await this.orderService.findOne(txCtx, fullOrder.id);
                        if (updatedOrder) {
                            const updatedLines = updatedOrder.lines.filter(l =>
                                Object.prototype.hasOwnProperty.call(variantPrices, l.productVariant.id as any)
                            );
                            await this.orderService.applyPriceAdjustments(txCtx, updatedOrder, updatedLines as any);
                        }
                        return true;
                    });
                    if (!isWritten) {
                        return { order: fullOrder, updated: false, changedCount: 0 };
                    }
                    // Reload final order
                    const finalOrder = await this.orderService.findOne(ctx, fullOrder.id);
                    return finalOrder ? { order: finalOrder, updated: true, changedCount: updates.length } : null;
                } catch (error: any) {
                    // Tax zone error: the transaction rolled back, so line prices and
                    // totals stay consistent (both old) instead of new prices with stale
                    // totals. The next read retries.
                    if (error.message?.includes('no-active-tax-zone')) {
                        Logger.debug(
                            `Price update skipped for order ${order.code}: totals could not be recalculated (no tax zone configured)`,
                            loggerCtx
                        );
                        return { order: fullOrder, updated: false, changedCount: 0 };
                    }
                    throw error; // Re-throw non-tax errors
                }
            }

            return { order: fullOrder, updated: false, changedCount: 0 };
        } catch (e: any) {
            Logger.error(
                `Price update failed for order ${order.id}: ${e.message}`,
                loggerCtx
            );
            throw e;
        }
    }
}

