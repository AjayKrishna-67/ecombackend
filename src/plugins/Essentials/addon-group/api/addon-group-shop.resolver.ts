import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, ID, Order, OrderLine, RequestContext, Transaction, TransactionalConnection } from '@vendure/core';
import { AddonGroup } from '../entities/addon-group.entity';
import { AddonGroupService } from '../services/addon-group.service';
import { AddonGroupDataLoader } from './addon-group.dataloader';

@Resolver()
export class AddonGroupShopResolver {
    constructor(private addonGroupService: AddonGroupService) {}

    @Query()
    async addonGroupsForVariant(
        @Ctx() ctx: RequestContext,
        @Args() args: { productVariantId: ID },
    ): Promise<AddonGroup[]> {
        return this.addonGroupService.findByVariant(ctx, args.productVariantId, true);
    }

    @Mutation()
    @Transaction()
    async addAddonsToOrderLine(
        @Ctx() ctx: RequestContext,
        @Args('input') input: {
            orderLineId: ID;
            selections: Array<{
                addonGroupId: ID;
                items: Array<{ addonItemId: ID; quantity: number }>;
            }>;
        },
    ): Promise<any> {
        return this.addonGroupService.addAddonsToOrderLine(ctx, input);
    }
}

/**
 * Resolves the `addonSelections` field on OrderLine by parsing
 * the JSON stored in customFields.addonSelections, then joining against the
 * live AddonGroup/AddonItem records so each entry carries an up-to-date
 * `enabled` flag. The storefront uses this to grey out addon chips whose
 * group or item has since been disabled or deleted (mirroring how disabled
 * product variants are rendered in the active order).
 */
@Resolver('OrderLine')
export class OrderLineAddonResolver {
    constructor(private addonGroupDataLoader: AddonGroupDataLoader) {}

    private async resolveSelectionsWithEnabled(ctx: RequestContext, orderLine: OrderLine): Promise<any[]> {
        const raw = (orderLine.customFields as any)?.addonSelections;
        if (!raw) return [];
        let parsed: any[];
        try {
            parsed = JSON.parse(raw);
        } catch {
            return [];
        }
        if (!Array.isArray(parsed) || parsed.length === 0) return [];

        const groupIds = parsed.map(g => g?.groupId).filter(Boolean);
        const liveGroups = groupIds.length === 0
            ? []
            : (await this.addonGroupDataLoader.getLoader(ctx).loadMany(groupIds))
                .filter((group): group is AddonGroup => !!group && !(group instanceof Error));
        const groupById = new Map(liveGroups.map(g => [String(g.id), g]));

        return parsed.map(snapshot => {
            const liveGroup = groupById.get(String(snapshot.groupId));
            const groupEnabled = !!liveGroup?.enabled;
            const liveItemById = new Map((liveGroup?.items || []).map(i => [String(i.id), i]));
            return {
                ...snapshot,
                enabled: groupEnabled,
                items: (snapshot.items || []).map((it: any) => {
                    const liveItem = liveItemById.get(String(it.itemId));
                    return {
                        ...it,
                        enabled: groupEnabled && !!liveItem?.enabled,
                    };
                }),
            };
        });
    }

    @ResolveField()
    async addonSelections(@Ctx() ctx: RequestContext, @Parent() orderLine: OrderLine): Promise<any[]> {
        return this.resolveSelectionsWithEnabled(ctx, orderLine);
    }

    /**
     * False as soon as any addon (group or item) on this line is disabled or
     * deleted in admin. Storefront/admin uses this to mark the whole order line
     * as "Out of stock", the same way it would for a disabled product variant.
     * If the line has no addons at all, this is `true`.
     */
    @ResolveField()
    async addonsAvailable(@Ctx() ctx: RequestContext, @Parent() orderLine: OrderLine): Promise<boolean> {
        const enriched = await this.resolveSelectionsWithEnabled(ctx, orderLine);
        if (enriched.length === 0) return true;
        for (const group of enriched) {
            if (!group.enabled) return false;
            for (const item of group.items || []) {
                if (!item.enabled) return false;
            }
        }
        return true;
    }

    /**
     * Legacy alias for `linePriceWithTax`. With AddonPriceCalculationStrategy
     * registered, the line's unitPrice already includes addon prices, so
     * `linePriceWithTax` is the addon-inclusive total — this field just mirrors
     * it for back-compat with storefronts that already query `priceWithAddons`.
     *
     * New code should query `linePriceWithTax` directly.
     */
    @ResolveField()
    priceWithAddons(@Parent() orderLine: OrderLine): number {
        return orderLine.linePriceWithTax ?? 0;
    }
}

/**
 * Order-level addon helper.
 *
 * `addonsTotal` is the **breakdown** of how much of the order's subtotal is
 * attributable to addons (Σ per-unit addons × line quantity, across all lines).
 * It is NOT an extra amount to add on top of `Order.totalWithTax` — addons are
 * already baked into each line's `unitPrice` by AddonPriceCalculationStrategy,
 * so they're already counted in `subTotalWithTax` and `totalWithTax`.
 *
 * Use `addonsTotal` for storefront breakdowns like "of which ₹X is addons".
 */
@Resolver('Order')
export class OrderAddonResolver {
    constructor(private connection: TransactionalConnection) {}

    private async loadLines(ctx: RequestContext, order: Order): Promise<OrderLine[]> {
        if (Array.isArray(order.lines) && order.lines.length > 0 && (order.lines[0] as any)?.customFields !== undefined) {
            return order.lines;
        }
        return this.connection.getRepository(ctx, OrderLine).find({
            where: { order: { id: order.id } },
        });
    }

    @ResolveField()
    async addonsTotal(@Ctx() ctx: RequestContext, @Parent() order: Order): Promise<number> {
        const lines = await this.loadLines(ctx, order);
        let total = 0;
        for (const line of lines) {
            const raw = (line.customFields as any)?.addonSelections;
            if (!raw) continue;
            let perUnit = 0;
            try {
                const groups: Array<{ items: Array<{ quantity: number; unitPrice: number }> }> = JSON.parse(raw);
                for (const group of groups) {
                    for (const item of group.items) {
                        perUnit += (item.quantity || 0) * (item.unitPrice || 0);
                    }
                }
            } catch {
                continue;
            }
            // Addons apply per-unit, so multiply by the order line's quantity.
            total += perUnit * (line.quantity || 1);
        }
        return total;
    }

}
