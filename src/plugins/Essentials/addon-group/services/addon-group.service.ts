import { Injectable } from '@nestjs/common';
import { DeletionResponse, DeletionResult } from '@vendure/common/lib/generated-types';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import {
    ActiveOrderService,
    Asset,
    Channel,
    ChannelService,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    Order,
    OrderLine,
    OrderService,
    RelationPaths,
    RequestContext,
    TransactionalConnection,
    UserInputError,
    assertFound,
    ProductVariant,
    EntityNotFoundError,
    isGraphQlErrorResult,
} from '@vendure/core';

const loggerCtx = 'AddonGroupService';
import { Surcharge } from '@vendure/core/dist/entity/surcharge/surcharge.entity';
import { AddonGroup, AddonSelectionType } from '../entities/addon-group.entity';
import { AddonItem } from '../entities/addon-item.entity';

// Produces a stable JSON for an addonSelections array so that two equivalent
// selections (same items, possibly chosen in different order) compare as equal.
// Used by addAddonsToOrderLine to detect order lines that should be merged.
function normalizeAddonSelections(selections: any[]): string {
    const normalized = (selections || [])
        .map(g => ({
            groupId: String(g.groupId),
            groupName: g.groupName,
            selectionType: g.selectionType,
            items: [...(g.items || [])]
                .map((i: any) => ({
                    itemId: String(i.itemId),
                    itemName: i.itemName,
                    quantity: i.quantity,
                    unitPrice: i.unitPrice,
                    imageUrl: i.imageUrl ?? null,
                }))
                .sort((a, b) => a.itemId.localeCompare(b.itemId)),
        }))
        .sort((a, b) => a.groupId.localeCompare(b.groupId));
    return JSON.stringify(normalized);
}

interface CreateAddonGroupInput {
    name: string;
    description?: string;
    selectionType?: string;
    isRequired?: boolean;
    minSelections?: number;
    maxSelections?: number;
    sortOrder?: number;
    enabled?: boolean;
}

interface UpdateAddonGroupInput {
    id: ID;
    name?: string;
    description?: string;
    selectionType?: string;
    isRequired?: boolean;
    minSelections?: number;
    maxSelections?: number;
    sortOrder?: number;
    enabled?: boolean;
}

interface CreateAddonItemInput {
    groupId: ID;
    name: string;
    price?: number;
    sku?: string;
    isDefault?: boolean;
    minQuantity?: number;
    maxQuantity?: number;
    sortOrder?: number;
    enabled?: boolean;
    imageId?: ID;
}

interface UpdateAddonItemInput {
    id: ID;
    name?: string;
    price?: number;
    sku?: string;
    isDefault?: boolean;
    minQuantity?: number;
    maxQuantity?: number;
    sortOrder?: number;
    enabled?: boolean;
    imageId?: ID | null;
}

interface AddonItemSelectionInput {
    addonItemId: ID;
    quantity: number;
}

interface AddonGroupSelectionInput {
    addonGroupId: ID;
    items: AddonItemSelectionInput[];
}

interface AddAddonsToOrderLineInput {
    orderLineId: ID;
    selections: AddonGroupSelectionInput[];
}

@Injectable()
export class AddonGroupService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private orderService: OrderService,
        private channelService: ChannelService,
        private activeOrderService: ActiveOrderService,
    ) {}

    private mergeRelations(relations?: RelationPaths<AddonGroup>): string[] {
        const required = ['items', 'items.image', 'channels'];
        const extra = (relations || []) as string[];
        return [...new Set([...required, ...extra])];
    }

    /**
     * Returns product variants that have this addon group assigned via custom field relation.
     */
    async findVariantsByAddonGroup(
        ctx: RequestContext,
        addonGroupId: ID,
    ): Promise<Array<{ id: ID; name: string; sku: string; productId: ID; productName: string }>> {
        const repo = this.connection.getRepository(ctx, ProductVariant);
        // Vendure stores custom field ManyToMany relations in an auto-generated join table
        const raw: Array<{ productVariantId: number }> = await repo.manager.query(
            `SELECT productVariantId FROM product_variant_custom_fields_addon_groups_addon_group WHERE addonGroupId = ?`,
            [addonGroupId],
        );
        if (raw.length === 0) return [];
        const variantIds = raw.map(r => r.productVariantId);
        const variants = await repo.find({
            where: variantIds.map(id => ({ id })),
            relations: ['product', 'product.translations', 'translations'],
        });
        return variants.map(v => {
            const variantTranslation = v.translations?.find(t => t.languageCode === ctx.languageCode) || v.translations?.[0];
            const productTranslation = v.product?.translations?.find(t => t.languageCode === ctx.languageCode) || v.product?.translations?.[0];
            return {
                id: v.id,
                name: variantTranslation?.name || v.sku || '',
                sku: v.sku,
                productId: v.product.id,
                productName: productTranslation?.name || '',
            };
        });
    }

    findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<AddonGroup>,
        relations?: RelationPaths<AddonGroup>,
    ): Promise<PaginatedList<AddonGroup>> {
        return this.listQueryBuilder
            .build(AddonGroup, options, {
                relations: this.mergeRelations(relations),
                ctx,
                where: { channels: { id: ctx.channelId } },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    findOne(
        ctx: RequestContext,
        id: ID,
        relations?: RelationPaths<AddonGroup>,
    ): Promise<AddonGroup | null> {
        return this.connection.getRepository(ctx, AddonGroup).findOne({
            where: { id },
            relations: this.mergeRelations(relations),
        });
    }

    /**
     * Finds addon groups assigned to a product variant via the custom field relation.
     * Returns only enabled groups with enabled items (for shop API).
     */
    async findByVariant(
        ctx: RequestContext,
        productVariantId: ID,
        enabledOnly: boolean = false,
    ): Promise<AddonGroup[]> {
        const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
            where: { id: productVariantId },
            relations: [
                'customFields.addonGroups',
                'customFields.addonGroups.items',
                'customFields.addonGroups.items.image',
                'customFields.addonGroups.channels',
            ],
        });
        if (!variant) {
            return [];
        }
        let groups: AddonGroup[] = (variant.customFields as any)?.addonGroups || [];
        // Filter by current channel
        groups = groups.filter(g =>
            g.channels?.some(ch => String(ch.id) === String(ctx.channelId)),
        );
        if (enabledOnly) {
            groups = groups
                .filter(g => g.enabled)
                .map(g => ({
                    ...g,
                    items: g.items.filter(item => item.enabled),
                }));
        }
        groups.sort((a, b) => a.sortOrder - b.sortOrder);
        groups.forEach(g => g.items.sort((a, b) => a.sortOrder - b.sortOrder));
        return groups;
    }

    async create(ctx: RequestContext, input: CreateAddonGroupInput): Promise<AddonGroup> {
        const minSelections = input.minSelections ?? 0;
        const maxSelections = input.maxSelections ?? 1;
        const selectionType = (input.selectionType as AddonSelectionType) || AddonSelectionType.CHECKBOX;
        this.validateSelections(minSelections, maxSelections);
        if (input.isRequired && minSelections < 1) {
            throw new UserInputError('Required addon groups must have minSelections >= 1');
        }
        const group = new AddonGroup({
            name: input.name,
            description: input.description || null,
            selectionType,
            isRequired: input.isRequired ?? false,
            minSelections,
            maxSelections,
            sortOrder: input.sortOrder ?? 0,
            enabled: input.enabled ?? true,
        });
        group.channels = [ctx.channel];
        const saved = await this.connection.getRepository(ctx, AddonGroup).save(group);
        return assertFound(this.findOne(ctx, saved.id));
    }

    async update(ctx: RequestContext, input: UpdateAddonGroupInput): Promise<AddonGroup> {
        const group = await this.connection.getEntityOrThrow(ctx, AddonGroup, input.id, {
            relations: ['channels'],
        });
        if (input.name !== undefined) group.name = input.name;
        if (input.description !== undefined) group.description = input.description;
        if (input.selectionType !== undefined) group.selectionType = input.selectionType as AddonSelectionType;
        if (input.isRequired !== undefined) group.isRequired = input.isRequired;
        if (input.minSelections !== undefined) group.minSelections = input.minSelections;
        if (input.maxSelections !== undefined) group.maxSelections = input.maxSelections;
        if (input.sortOrder !== undefined) group.sortOrder = input.sortOrder;
        if (input.enabled !== undefined) group.enabled = input.enabled;
        this.validateSelections(group.minSelections, group.maxSelections);
        if (group.isRequired && group.minSelections < 1) {
            throw new UserInputError('Required addon groups must have minSelections >= 1');
        }
        await this.connection.getRepository(ctx, AddonGroup).save(group);
        return assertFound(this.findOne(ctx, group.id));
    }

    private validateSelections(minSelections: number, maxSelections: number): void {
        if (maxSelections < 1) {
            throw new UserInputError('maxSelections must be at least 1');
        }
        if (minSelections < 0) {
            throw new UserInputError('minSelections must be at least 0');
        }
        if (minSelections > maxSelections) {
            throw new UserInputError('minSelections cannot be greater than maxSelections');
        }
    }

    async delete(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const group = await this.connection.getRepository(ctx, AddonGroup).findOne({
            where: { id },
            relations: ['channels'],
        });
        if (!group) {
            throw new EntityNotFoundError('AddonGroup', id);
        }
        try {
            await this.connection.getRepository(ctx, AddonGroup).remove(group);
            return { result: DeletionResult.DELETED };
        } catch (e: any) {
            return { result: DeletionResult.NOT_DELETED, message: e.toString() };
        }
    }

    async createItem(ctx: RequestContext, input: CreateAddonItemInput): Promise<AddonItem> {
        if (input.price !== undefined && input.price < 0) {
            throw new UserInputError('Price must not be negative');
        }
        if (input.maxQuantity !== undefined && input.maxQuantity < 1) {
            throw new UserInputError('maxQuantity must be at least 1');
        }
        if (input.minQuantity !== undefined && input.minQuantity < 0) {
            throw new UserInputError('minQuantity must be at least 0');
        }
        const group = await this.connection.getEntityOrThrow(ctx, AddonGroup, input.groupId);
        const item = new AddonItem({
            name: input.name,
            price: input.price ?? 0,
            sku: input.sku || null,
            isDefault: input.isDefault ?? false,
            minQuantity: input.minQuantity ?? 0,
            maxQuantity: input.maxQuantity ?? 1,
            sortOrder: input.sortOrder ?? 0,
            enabled: input.enabled ?? true,
            group,
        });
        if (input.imageId) {
            item.image = await this.connection.getEntityOrThrow(ctx, Asset, input.imageId);
        }
        const saved = await this.connection.getRepository(ctx, AddonItem).save(item);
        return this.connection.getRepository(ctx, AddonItem).findOne({
            where: { id: saved.id },
            relations: ['image'],
        }) as Promise<AddonItem>;
    }

    async updateItem(ctx: RequestContext, input: UpdateAddonItemInput): Promise<AddonItem> {
        if (input.price !== undefined && input.price < 0) {
            throw new UserInputError('Price must not be negative');
        }
        if (input.maxQuantity !== undefined && input.maxQuantity < 1) {
            throw new UserInputError('maxQuantity must be at least 1');
        }
        if (input.minQuantity !== undefined && input.minQuantity < 0) {
            throw new UserInputError('minQuantity must be at least 0');
        }
        const item = await this.connection.getEntityOrThrow(ctx, AddonItem, input.id, {
            relations: ['image'],
        });
        if (input.name !== undefined) item.name = input.name;
        if (input.price !== undefined) item.price = input.price;
        if (input.sku !== undefined) item.sku = input.sku;
        if (input.isDefault !== undefined) item.isDefault = input.isDefault;
        if (input.minQuantity !== undefined) item.minQuantity = input.minQuantity;
        if (input.maxQuantity !== undefined) item.maxQuantity = input.maxQuantity;
        if (input.sortOrder !== undefined) item.sortOrder = input.sortOrder;
        if (input.enabled !== undefined) item.enabled = input.enabled;
        if (input.imageId !== undefined) {
            if (input.imageId === null) {
                item.image = null;
            } else {
                item.image = await this.connection.getEntityOrThrow(ctx, Asset, input.imageId);
            }
        }
        const saved = await this.connection.getRepository(ctx, AddonItem).save(item);
        return this.connection.getRepository(ctx, AddonItem).findOne({
            where: { id: saved.id },
            relations: ['image'],
        }) as Promise<AddonItem>;
    }

    async deleteItem(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        const item = await this.connection.getRepository(ctx, AddonItem).findOne({
            where: { id },
        });
        if (!item) {
            throw new EntityNotFoundError('AddonItem', id);
        }
        try {
            await this.connection.getRepository(ctx, AddonItem).remove(item);
            return { result: DeletionResult.DELETED };
        } catch (e: any) {
            return { result: DeletionResult.NOT_DELETED, message: e.toString() };
        }
    }

    /**
     * Adds addon selections to an existing order line.
     * Validates all selections, snapshots data into JSON, and adds price surcharge.
     */
    async addAddonsToOrderLine(
        ctx: RequestContext,
        input: AddAddonsToOrderLineInput,
    ): Promise<any> {
        // Capture session / channel / user diagnostics up front so any failure
        // below logs enough context to identify which client request hit it
        // (mobile app's "couldn't save customisations" warning is generic —
        // the real error is whichever throw fires here).
        const diag = {
            requestedOrderLineId: String(input.orderLineId),
            channelId: String(ctx.channelId),
            sessionId: (ctx as any).session?.id ? String((ctx as any).session.id) : null,
            sessionActiveOrderId: (ctx as any).session?.activeOrderId
                ? String((ctx as any).session.activeOrderId)
                : null,
            activeUserId: ctx.activeUserId ? String(ctx.activeUserId) : null,
            authorizedAsOwnerOnly: !!(ctx as any).authorizedAsOwnerOnly,
            selectionsCount: input.selections?.length ?? 0,
        };

        const activeOrder = await this.activeOrderService.getActiveOrder(ctx, undefined);
        if (!activeOrder) {
            Logger.warn(
                `addAddonsToOrderLine failed: no active order on session. diag=${JSON.stringify(diag)}`,
                loggerCtx,
            );
            throw new UserInputError('No active order found');
        }
        const order = await this.orderService.findOne(ctx, activeOrder.id, ['lines', 'lines.productVariant']);
        if (!order) {
            Logger.warn(
                `addAddonsToOrderLine failed: activeOrder.id=${activeOrder.id} not loadable via orderService.findOne. diag=${JSON.stringify(diag)}`,
                loggerCtx,
            );
            throw new UserInputError('No active order found');
        }
        const orderLine = order.lines.find(l => String(l.id) === String(input.orderLineId));
        if (!orderLine) {
            // Most common failure for the mobile-app guest flow: the orderLineId
            // the app sent doesn't belong to the session's active order. Either
            // the bearer token changed between addItemToOrder and this call, or
            // the app is sending a stale/wrong id.
            const lineRow: { id: ID; orderId: ID } | undefined = await this.connection.getRepository(ctx, OrderLine)
                .createQueryBuilder('ol')
                .select(['ol.id AS id', 'ol.orderId AS orderId'])
                .where('ol.id = :id', { id: input.orderLineId })
                .getRawOne();
            Logger.warn(
                `addAddonsToOrderLine failed: orderLineId=${input.orderLineId} not in active order ${order.id} (state=${order.state}, lines=${order.lines.map(l => l.id).join(',')}). orderLineExistsOnOrderId=${lineRow ? String(lineRow.orderId) : 'NOT_FOUND_IN_DB'}. diag=${JSON.stringify(diag)}`,
                loggerCtx,
            );
            throw new EntityNotFoundError('OrderLine', input.orderLineId);
        }
        const variantId = (orderLine as any).productVariantId ?? orderLine.productVariant?.id;
        // NB: pulling productVariantPrices so the safeguard at the bottom of this
        // method can read the variant's actual per-channel price. Without this,
        // both variant.listPrice (set by applyChannelPriceAndTax) and variant.price
        // are undefined, and the safeguard's fallback "?? 0" stripped the base
        // variant price out of the line's listPrice.
        const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
            where: { id: variantId },
            relations: ['customFields.addonGroups', 'customFields.addonGroups.items', 'customFields.addonGroups.items.image', 'translations', 'productVariantPrices'],
        });
        if (!variant) {
            Logger.warn(
                `addAddonsToOrderLine failed: variantId=${variantId} not found. diag=${JSON.stringify(diag)}`,
                loggerCtx,
            );
            throw new UserInputError('Product variant not found for this order line');
        }
        const assignedGroups: AddonGroup[] = (variant.customFields as any)?.addonGroups || [];
        // logValidationFailure logs the reason any validation throw fired, then
        // re-throws. Mobile-app error message is generic ("couldn't be saved");
        // server log is the only place to see what actually went wrong.
        const logValidationFailure = (reason: string): never => {
            Logger.warn(
                `addAddonsToOrderLine validation failed: ${reason}. variantId=${variantId}, assignedGroupIds=[${assignedGroups.map(g => g.id).join(',')}], inputSelections=${JSON.stringify(input.selections)}, diag=${JSON.stringify(diag)}`,
                loggerCtx,
            );
            throw new UserInputError(reason);
        };
        // Validate that all required groups are included in the selections
        for (const group of assignedGroups) {
            if (!group.enabled) continue;
            if (group.isRequired) {
                const sel = input.selections.find(s => String(s.addonGroupId) === String(group.id));
                if (!sel || sel.items.length < group.minSelections) {
                    logValidationFailure(
                        `Addon group "${group.name}" is required and needs at least ${group.minSelections} selection(s)`,
                    );
                }
            }
        }
        const addonSelections: any[] = [];
        for (const sel of input.selections) {
            const group = assignedGroups.find(g => String(g.id) === String(sel.addonGroupId));
            if (!group) {
                logValidationFailure(`Addon group ${sel.addonGroupId} is not assigned to this product variant`);
            }
            if (!group!.enabled) {
                logValidationFailure(`Addon group "${group!.name}" is disabled`);
            }
            const selectedCount = sel.items.length;
            if (selectedCount < group!.minSelections) {
                logValidationFailure(`Addon group "${group!.name}" requires at least ${group!.minSelections} selection(s)`);
            }
            if (selectedCount > group!.maxSelections) {
                logValidationFailure(`Addon group "${group!.name}" allows at most ${group!.maxSelections} selection(s)`);
            }
            const selectionItems: any[] = [];
            for (const itemSel of sel.items) {
                const addonItem = group!.items.find(i => String(i.id) === String(itemSel.addonItemId));
                if (!addonItem) {
                    logValidationFailure(`Addon item ${itemSel.addonItemId} not found in group "${group!.name}"`);
                }
                if (!addonItem!.enabled) {
                    logValidationFailure(`Addon item "${addonItem!.name}" is disabled`);
                }
                if (group!.selectionType === AddonSelectionType.CHECKBOX && itemSel.quantity !== 1) {
                    logValidationFailure(`Checkbox items must have quantity 1`);
                }
                if (group!.selectionType === AddonSelectionType.QUANTITY) {
                    if (itemSel.quantity < addonItem!.minQuantity) {
                        logValidationFailure(`"${addonItem!.name}" requires minimum quantity of ${addonItem!.minQuantity}`);
                    }
                    if (itemSel.quantity > addonItem!.maxQuantity) {
                        logValidationFailure(`"${addonItem!.name}" allows maximum quantity of ${addonItem!.maxQuantity}`);
                    }
                }
                selectionItems.push({
                    itemId: String(addonItem!.id),
                    itemName: addonItem!.name,
                    quantity: itemSel.quantity,
                    unitPrice: addonItem!.price,
                    imageUrl: addonItem!.image?.preview ? `https://cdn.kaaikani.co.in/${addonItem!.image.preview}` : null,
                });
            }
            addonSelections.push({
                groupId: String(group!.id),
                groupName: group!.name,
                selectionType: group!.selectionType,
                items: selectionItems,
            });
        }
        // Normalize the selections so two equivalent picks (same items, different
        // selection order) produce identical JSON. Lets us merge order lines whose
        // addons match logically even if the customer ticked them in a different order.
        const newSelectionsJson = normalizeAddonSelections(addonSelections);

        // Find another line on the order with the same variant and the same addons.
        // Vendure's built-in addItemToOrder merge runs at line-creation time when the
        // new line has no customFields yet, so two same-variant-same-addon adds always
        // produce two separate lines. Merge them here instead.
        const mergeTarget = order.lines.find(l => {
            if (String(l.id) === String(orderLine.id)) return false;
            const lVariantId = (l as any).productVariantId ?? l.productVariant?.id;
            if (String(lVariantId) !== String(variantId)) return false;
            const stored = (l.customFields as any)?.addonSelections;
            if (!stored) return false;
            try {
                const parsed = JSON.parse(stored);
                return normalizeAddonSelections(parsed) === newSelectionsJson;
            } catch {
                return false;
            }
        });

        // Clean up any legacy ADDON-* surcharges on the surviving line (and on the
        // line we're about to remove, in case it had stale legacy data too). The
        // current flow doesn't create surcharges, so this is purely for old data.
        const survivingLineId = mergeTarget ? mergeTarget.id : orderLine.id;
        const skusToClean = mergeTarget
            ? [`ADDON-${orderLine.id}`, `ADDON-${mergeTarget.id}`]
            : [`ADDON-${orderLine.id}`];
        const existingSurcharges = await this.connection.getRepository(ctx, Surcharge).find({
            where: skusToClean.map(sku => ({ order: { id: order.id }, sku })),
        });
        for (const surcharge of existingSurcharges) {
            await this.orderService.removeSurchargeFromOrder(ctx, order.id, surcharge.id);
        }

        let resultOrder: Order | undefined;
        if (mergeTarget) {
            // Bump the existing line's quantity, then remove the duplicate.
            const mergedQty = mergeTarget.quantity + orderLine.quantity;
            const bumpResult = await this.orderService.adjustOrderLine(
                ctx,
                order.id,
                mergeTarget.id,
                mergedQty,
                { addonSelections: newSelectionsJson },
            );
            if (isGraphQlErrorResult(bumpResult)) {
                throw new UserInputError((bumpResult as any).message || 'Failed to merge order lines');
            }
            const removeResult = await this.orderService.removeItemFromOrder(ctx, order.id, orderLine.id);
            if (isGraphQlErrorResult(removeResult)) {
                throw new UserInputError((removeResult as any).message || 'Failed to remove duplicate line');
            }
            resultOrder = removeResult as Order;
        } else {
            // No matching line — store the JSON on the current line. The price
            // calculation strategy reads this and bakes the addon price into the
            // line's unit price, so subtotal/total reflect addons automatically.
            const adjustResult = await this.orderService.adjustOrderLine(
                ctx,
                order.id,
                orderLine.id,
                orderLine.quantity,
                { addonSelections: newSelectionsJson },
            );
            if (isGraphQlErrorResult(adjustResult)) {
                throw new UserInputError((adjustResult as any).message || 'Failed to store addon selections');
            }
            resultOrder = adjustResult as Order;
        }

        // Safeguard: verify that AddonPriceCalculationStrategy actually persisted
        // the addon-inclusive listPrice on the surviving line, AND that the order's
        // subTotal reflects it. Two failure modes observed in production:
        //   1. The strategy result is not written back to the OrderLine row, leaving
        //      the line at the variant-only price.
        //   2. The line listPrice persists correctly, but applyPriceAdjustments writes
        //      Order.subTotal from a stale in-memory line value (race), so the cart
        //      header/total shows the variant-only price even though line totals are
        //      correct.
        // We therefore (a) repair listPrice when wrong, and (b) ALWAYS re-derive
        // subTotal/subTotalWithTax from the current DB line prices so the two stay in
        // sync. Both writes are cheap and idempotent.
        const perUnitAddons = addonSelections.reduce(
            (sum, group: any) =>
                sum + (group.items || []).reduce(
                    (s: number, i: any) => s + (i.quantity || 0) * (i.unitPrice || 0),
                    0,
                ),
            0,
        );
        // Resolve the variant's actual base price for the current channel from
        // productVariantPrices. variant.listPrice / variant.price are only populated
        // after applyChannelPriceAndTax; for an entity loaded straight from the repo
        // both are undefined, and falling back to 0 would strip the base price out
        // of the corrected listPrice.
        const channelPriceRow = (variant as any).productVariantPrices?.find(
            (p: any) => String(p.channelId) === String(ctx.channelId),
        );
        const variantListPrice =
            channelPriceRow?.price ?? (variant as any).listPrice ?? (variant as any).price ?? 0;
        const expectedListPrice = variantListPrice + perUnitAddons;
        const orderLineRepo = this.connection.getRepository(ctx, OrderLine);
        const stored = await orderLineRepo
            .createQueryBuilder('ol')
            .select(['ol.id', 'ol.listPrice', 'ol.quantity', 'ol.listPriceIncludesTax'])
            .where('ol.id = :id', { id: survivingLineId })
            .getOne();
        if (stored && stored.listPrice !== expectedListPrice) {
            await orderLineRepo
                .createQueryBuilder()
                .update()
                .set({ listPrice: expectedListPrice } as any)
                .where('id = :id', { id: survivingLineId })
                .execute();
        }
        // Re-derive the order subtotal from the now-current line prices. Done
        // unconditionally — applyPriceAdjustments inside adjustOrderLine can write
        // a stale subTotal even when the line listPrice ends up correct, so the
        // header/total would otherwise still show the variant-only price.
        const allLines = await orderLineRepo
            .createQueryBuilder('ol')
            .select(['ol.id', 'ol.listPrice', 'ol.quantity'])
            .where('ol.orderId = :orderId', { orderId: order.id })
            .getMany();
        let newSubTotal = 0;
        for (const l of allLines) {
            newSubTotal += (l.listPrice ?? 0) * (l.quantity ?? 0);
        }
        const orderRow = await this.connection.getRepository(ctx, Order)
            .createQueryBuilder('o')
            .select(['o.id', 'o.subTotal', 'o.subTotalWithTax'])
            .where('o.id = :id', { id: order.id })
            .getOne();
        if (orderRow && (orderRow.subTotal !== newSubTotal || orderRow.subTotalWithTax !== newSubTotal)) {
            await this.connection.getRepository(ctx, Order)
                .createQueryBuilder()
                .update()
                .set({
                    subTotal: newSubTotal,
                    subTotalWithTax: newSubTotal,
                } as any)
                .where('id = :id', { id: order.id })
                .execute();
        }

        // Refetch with `lines` (and the productVariant relation each line resolver
        // needs) hydrated, so the returned Order can be serialized by the GraphQL
        // layer without tripping the non-null `Order.lines` field resolver.
        const refetched = await this.orderService.findOne(ctx, resultOrder.id, [
            'lines',
            'lines.productVariant',
        ]);
        return refetched ?? resultOrder;
    }

    /**
     * Fast post-mutation reconciler. For each line carrying an `addonSelections`
     * snapshot, asserts the stored `listPrice` matches
     *   variant.price + Σ(addon.unitPrice × addon.quantity)
     * If not, force-corrects the line and the order subtotal directly via SQL.
     *
     * Intended to run from an `OrderEvent` subscriber so that every mutation
     * — `addItemToOrder`, `adjustOrderLine`, our own `addAddonsToOrderLine`,
     * or anything else that touches the order — gets the same correction
     * applied. Cheap: only DB writes happen when a mismatch is detected.
     */
    async correctAddonPricesForOrder(ctx: RequestContext, orderId: ID): Promise<void> {
        const orderLineRepo = this.connection.getRepository(ctx, OrderLine);
        const lines = await orderLineRepo
            .createQueryBuilder('ol')
            .leftJoinAndSelect('ol.productVariant', 'pv')
            .where('ol.orderId = :orderId', { orderId })
            .getMany();
        if (lines.length === 0) return;

        for (const line of lines) {
            const raw = (line.customFields as any)?.addonSelections as string | undefined;
            if (!raw) continue;
            let perUnitAddons = 0;
            try {
                const groups: Array<{ items: Array<{ quantity: number; unitPrice: number }> }> = JSON.parse(raw);
                for (const g of groups) {
                    for (const i of g.items) {
                        perUnitAddons += (i.quantity || 0) * (i.unitPrice || 0);
                    }
                }
            } catch {
                continue;
            }
            if (perUnitAddons === 0) continue;
            const variantPrice = (line.productVariant as any)?.listPrice ?? (line.productVariant as any)?.price ?? 0;
            const expectedListPrice = variantPrice + perUnitAddons;
            if (line.listPrice === expectedListPrice) continue;
            await orderLineRepo
                .createQueryBuilder()
                .update()
                .set({ listPrice: expectedListPrice } as any)
                .where('id = :id', { id: line.id })
                .execute();
        }

        // Always re-derive the order subtotal from the now-current line prices.
        // Even when no line listPrice needed correcting, applyPriceAdjustments
        // upstream can persist a stale Order.subTotal — re-summing here keeps
        // line totals and the header subtotal in sync.
        const refreshed = await orderLineRepo
            .createQueryBuilder('ol')
            .select(['ol.id', 'ol.listPrice', 'ol.quantity'])
            .where('ol.orderId = :orderId', { orderId })
            .getMany();
        let newSubTotal = 0;
        for (const l of refreshed) {
            newSubTotal += (l.listPrice ?? 0) * (l.quantity ?? 0);
        }
        const orderRow = await this.connection.getRepository(ctx, Order)
            .createQueryBuilder('o')
            .select(['o.id', 'o.subTotal', 'o.subTotalWithTax'])
            .where('o.id = :id', { id: orderId })
            .getOne();
        if (!orderRow || (orderRow.subTotal === newSubTotal && orderRow.subTotalWithTax === newSubTotal)) {
            return;
        }
        await this.connection.getRepository(ctx, Order)
            .createQueryBuilder()
            .update()
            .set({ subTotal: newSubTotal, subTotalWithTax: newSubTotal } as any)
            .where('id = :id', { id: orderId })
            .execute();
    }

    /**
     * Reconciles an order's addon pricing so its subtotal/total reflect addon
     * prices stored on each line's `addonSelections` JSON.
     *
     * - Removes any legacy `ADDON-*` surcharges from the old surcharge-based flow.
     * - For orders still in `AddingItems`, re-triggers `OrderService.adjustOrderLine`
     *   on every line that carries an `addonSelections` snapshot. That re-runs the
     *   `AddonPriceCalculationStrategy` and persists fresh totals via Vendure's
     *   `applyPriceAdjustments`.
     * - For orders past `AddingItems` (state-restricted from `adjustOrderLine`),
     *   recomputes each addon line's `listPrice` directly in the DB and re-sums
     *   the order totals.
     */
    async recomputeAddonSurchargesForOrder(ctx: RequestContext, orderId: ID): Promise<boolean> {
        // 1. Remove legacy ADDON-* surcharges.
        const surchargeRepo = this.connection.getRepository(ctx, Surcharge);
        const stale = await surchargeRepo
            .createQueryBuilder('surcharge')
            .where('surcharge.orderId = :orderId', { orderId })
            .andWhere('surcharge.sku LIKE :sku', { sku: 'ADDON-%' })
            .getMany();
        if (stale.length > 0) {
            await surchargeRepo.remove(stale);
        }

        // 2. Reload the order with the relations we need for re-pricing.
        const order = await this.orderService.findOne(ctx, orderId, [
            'lines',
            'lines.productVariant',
        ]);
        if (!order) {
            throw new EntityNotFoundError('Order', orderId);
        }
        const addonLines = order.lines.filter(l => !!(l.customFields as any)?.addonSelections);

        if (order.state === 'AddingItems') {
            // 3a. Let Vendure re-price each addon line via the registered strategy.
            // adjustOrderLine -> applyPriceAdjustments updates listPrice and persists
            // fresh order subtotal/total.
            for (const line of addonLines) {
                const result = await this.orderService.adjustOrderLine(
                    ctx,
                    order.id,
                    line.id,
                    line.quantity,
                );
                if (isGraphQlErrorResult(result)) {
                    // Best-effort: skip lines we can't adjust (e.g. deleted variant).
                    continue;
                }
            }
            // If only stale surcharges were removed and no addon lines exist, totals
            // still need a nudge. Touch any line to force a recalc.
            if (addonLines.length === 0 && stale.length > 0 && order.lines.length > 0) {
                const anyLine = order.lines[0];
                await this.orderService.adjustOrderLine(ctx, order.id, anyLine.id, anyLine.quantity);
            }
            return true;
        }

        // 3b. Non-AddingItems: direct DB writes.
        const orderLineRepo = this.connection.getRepository(ctx, OrderLine);
        for (const line of addonLines) {
            const raw = (line.customFields as any)?.addonSelections as string;
            let perUnitAddons = 0;
            try {
                const groups: Array<{ items: Array<{ quantity: number; unitPrice: number }> }> = JSON.parse(raw);
                for (const g of groups) {
                    for (const i of g.items) {
                        perUnitAddons += (i.quantity || 0) * (i.unitPrice || 0);
                    }
                }
            } catch {
                continue;
            }
            const variantPrice = line.productVariant?.listPrice ?? line.listPrice;
            const newListPrice = variantPrice + perUnitAddons;
            await orderLineRepo
                .createQueryBuilder()
                .update()
                .set({ listPrice: newListPrice } as any)
                .where('id = :id', { id: line.id })
                .execute();
        }

        // Re-sum the order totals from the now-current line prices. This is a
        // best-effort fallback that ignores promotions/shipping deltas; for
        // AddingItems orders we go through Vendure's calculator instead.
        const orderRepo = this.connection.getRepository(ctx, Order);
        const lineRows = await orderLineRepo
            .createQueryBuilder('ol')
            .select(['ol.listPrice', 'ol.listPriceIncludesTax', 'ol.quantity'])
            .where('ol.orderId = :orderId', { orderId })
            .getMany();
        let newSubTotalWithTax = 0;
        for (const r of lineRows) {
            newSubTotalWithTax += (r.listPrice ?? 0) * (r.quantity ?? 0);
        }
        // Vendure exposes `total`/`totalWithTax` as derived fields, not DB columns;
        // updating subTotal is enough — the totals are computed on read from
        // subTotal + shipping + surcharges.
        await orderRepo
            .createQueryBuilder()
            .update()
            .set({
                subTotal: newSubTotalWithTax,
                subTotalWithTax: newSubTotalWithTax,
            } as any)
            .where('id = :id', { id: orderId })
            .execute();
        return true;
    }

    async assignToChannel(
        ctx: RequestContext,
        addonGroupIds: ID[],
        channelId: ID,
    ): Promise<AddonGroup[]> {
        const channel = await this.connection.getEntityOrThrow(ctx, Channel, channelId);
        const repo = this.connection.getRepository(ctx, AddonGroup);
        const updated: AddonGroup[] = [];
        for (const id of addonGroupIds) {
            const group = await repo.findOne({ where: { id }, relations: ['channels'] });
            if (!group) {
                throw new EntityNotFoundError('AddonGroup', id);
            }
            const alreadyAssigned = group.channels.some(c => String(c.id) === String(channel.id));
            if (!alreadyAssigned) {
                group.channels = [...group.channels, channel];
                await repo.save(group);
            }
            updated.push(await assertFound(this.findOne(ctx, id)));
        }
        return updated;
    }

    async removeFromChannel(
        ctx: RequestContext,
        addonGroupIds: ID[],
        channelId: ID,
    ): Promise<AddonGroup[]> {
        const defaultChannel = await this.channelService.getDefaultChannel(ctx);
        if (String(channelId) === String(defaultChannel.id)) {
            throw new UserInputError('Cannot remove addon groups from the default channel');
        }
        const repo = this.connection.getRepository(ctx, AddonGroup);
        const updated: AddonGroup[] = [];
        for (const id of addonGroupIds) {
            const group = await repo.findOne({ where: { id }, relations: ['channels'] });
            if (!group) {
                throw new EntityNotFoundError('AddonGroup', id);
            }
            group.channels = group.channels.filter(c => String(c.id) !== String(channelId));
            await repo.save(group);
            updated.push(await assertFound(this.findOne(ctx, id)));
        }
        return updated;
    }
}
