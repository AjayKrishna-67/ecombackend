import { Injectable } from '@nestjs/common';
import {
    EventBus,
    ID,
    Product,
    ProductVariant,
    ProductVariantEvent,
    RequestContext,
    StockLevelService,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In, IsNull } from 'typeorm';

import { ProductStockService } from '../../product-stock/services/product-stock.service';
import { GoodsTransfer } from '../entities/goods-transfer.entity';
import { GoodsTransferLine } from '../entities/goods-transfer-line.entity';
import { DEFAULT_POOL_UNIT, poolUnitSuffix, poolUnitsForProducts } from './pool-unit.helper';
import { TransferChannelService } from './transfer-channel.service';

export interface LineStockResult {
    lineId: ID;
    productName: string;
    path: 'variant' | 'pool';
    oldValue: number;
    newValue: number;
    /**
     * True when the line was received but no stock was posted, because the product or
     * variant is disabled in the destination channel.
     *
     * Reported rather than passed over in silence. A line that is entered, printed,
     * dispatched and received but quietly leaves stock untouched is the kind of thing
     * nobody discovers until the counts disagree months later; naming it here puts it
     * in the receive response and in the audit entry, where somebody can see it on the
     * day it happens.
     */
    skipped?: boolean;
    skipReason?: string;
}

/**
 * The ONE and ONLY writer of existing stock tables (GT-01).
 *
 * No resolver — not user-callable; invoked only by receipt approval and damage
 * approval, each inside its own transaction.
 *
 * ZERO new stock math: both write paths are the production-proven ones —
 *   PCS  → core StockLevelService.updateStockOnHandForLocation (delta)
 *   pool → ProductStockService.setProductStock (absolute grams; internally
 *          re-derives every variant's display stock via ensureVariantStockLevels)
 *
 * Disabled products post no stock. `enabled` is read LIVE at receipt, not snapshotted
 * at entry: a product taken off sale between dispatch and arrival must not land in a
 * branch's sellable stock, and one switched back on in that window should.
 *
 * After writing, one ProductVariantEvent('updated') is published so the search
 * index re-syncs (same guard the production location-stock tool uses).
 */
@Injectable()
export class TransferStockService {
    constructor(
        private connection: TransactionalConnection,
        private stockLevelService: StockLevelService,
        private productStockService: ProductStockService,
        private channelService: TransferChannelService,
        private eventBus: EventBus,
    ) {}

    /**
     * Receipt approval (GT-02): ADD every line's quantity to the DESTINATION
     * location. Adds never fail on insufficiency — that guard exists only for the
     * damage deduction below.
     */
    async applyReceipt(ctx: RequestContext, transfer: GoodsTransfer): Promise<LineStockResult[]> {
        return this.applyLines(ctx, transfer);
    }

    /**
     * Adds every line to the destination location. Returns per-line old→new for the
     * audit trail.
     *
     * PRIVATE, and additive only. This used to take a `sign` of +1 or -1, which made
     * it a method that could remove an entire transfer's worth of stock from a branch
     * in one call. Nothing in the design needs that: there is no revert (GT-06), and
     * the one legitimate deduction is an approved damage claim, which is per line and
     * carries its own cap and evidence rules (deductDamage). The parameter is gone so
     * the capability is gone with it.
     */
    private async applyLines(ctx: RequestContext, transfer: GoodsTransfer): Promise<LineStockResult[]> {
        if (!transfer.destinationStockLocationId) {
            throw new UserInputError('Destination stock location is not pinned — confirm the transfer first');
        }
        const locationId = transfer.destinationStockLocationId;
        const lines = await this.connection
            .getRepository(ctx, GoodsTransferLine)
            .find({ where: { transferId: transfer.id as any } });

        const results: LineStockResult[] = [];
        const affectedVariantIds = new Set<string>();

        for (const line of lines) {
            /*
              A product reclassified since dispatch (pool ↔ piece, or a new pool unit)
              no longer blocks the whole receipt. The goods are physically at the
              destination and every other line is fine; holding them all hostage to
              one product's setting left branches unable to receive anything.

              The mismatched line is received but posts NO stock, and is reported as
              skipped. Posting it either way would be wrong: a pool quantity written
              into a product that is now per-variant re-derives — and so overwrites —
              every variant's real count, and a piece count written into a product that
              is now pooled is overwritten the next time the pool is recalculated. The
              Admin Team adjusts that product by hand; the skip reason in the audit
              entry and the source's notification says which one and why.

              Damage approval still refuses on a mismatch (deductDamage) — a deduction
              has no "skip" that would leave the figures honest.
            */
            const mismatch = await this.lineMismatch(ctx, line);
            if (mismatch) {
                const current = await this.getCurrentStock(ctx, line, locationId);
                results.push({
                    lineId: line.id,
                    productName: line.productName,
                    path: line.isPooled ? 'pool' : 'variant',
                    oldValue: current,
                    newValue: current,
                    skipped: true,
                    skipReason: mismatch,
                });
                continue;
            }
            const product = await this.classifyLine(ctx, line);

            /*
              EVERY line posts stock, disabled or not.

              A disabled product used to be received and documented but deliberately
              left out of stock, on the reasoning that what is not on sale should not
              appear to be in stock. In practice that lost the count: the goods were
              physically on the destination's shelf and the system said there were
              none, so the branch had no record of what it was holding and no way to
              reconcile it later.

              The branch asked for the opposite, and it is the more honest of the two:
              post what actually arrived. `enabled` still does its own job — a disabled
              product does not reach the customer app — and the destination adjusts the
              figure by hand when the goods are dealt with.

              The picker still labels these lines "disabled", which now means only what
              it says: not on sale. It no longer implies anything about stock.
            */
            if (product.livePooled) {
                results.push(await this.addPoolLine(ctx, line, locationId));
                const variants = await this.connection
                    .getRepository(ctx, ProductVariant)
                    .find({ where: { productId: line.productId as any, deletedAt: IsNull() } });
                variants.forEach(v => affectedVariantIds.add(String(v.id)));
            } else {
                results.push(await this.addVariantLine(ctx, line, locationId));
                if (line.productVariantId) {
                    affectedVariantIds.add(String(line.productVariantId));
                }
            }
        }

        // Post-write reindex trigger (EventBus defers until commit).
        if (affectedVariantIds.size > 0) {
            const variants = await this.connection
                .getRepository(ctx, ProductVariant)
                .find({ where: { id: In([...affectedVariantIds]) as any } });
            await this.eventBus.publish(new ProductVariantEvent(ctx, variants, 'updated'));
        }
        return results;
    }

    /**
     * Damage deduction (GT-03): removes a SPECIFIC damaged amount for ONE line from
     * the destination location, inside the approval transaction.
     *
     * If current stock < the damaged amount the whole approval is BLOCKED — never
     * floored to zero. Stock that is already wrong is a discrepancy someone has to
     * look at; silently writing 0 would destroy the evidence of it.
     * Publishes ProductVariantEvent so the search index re-syncs.
     */
    async deductDamage(
        ctx: RequestContext,
        transfer: GoodsTransfer,
        line: GoodsTransferLine,
        damagedPcs: number | null,
        damagedGrams: number | null,
    ): Promise<LineStockResult> {
        if (!transfer.destinationStockLocationId) {
            throw new UserInputError('Destination stock location is not pinned');
        }
        const locationId = transfer.destinationStockLocationId;
        const { livePooled } = await this.classifyLine(ctx, line);
        // The branch is named from the transfer, never hardcoded: this message is read
        // at whichever destination raised the claim, not at one particular branch.
        const branch = await this.destinationName(ctx, transfer);

        let result: LineStockResult;
        if (livePooled) {
            if (damagedGrams == null || damagedGrams <= 0) {
                throw new UserInputError('damagedGrams must be positive for a weight (pool) product');
            }
            const levels = await this.productStockService.getProductStockLevels(ctx, line.productId);
            const current = levels.find(l => String(l.stockLocationId) === String(locationId))?.stockOnHand ?? 0;
            if (current - damagedGrams < 0) {
                throw new UserInputError(
                    `Cannot approve damage: current ${branch} stock of "${line.productName}" is ${current} g, ` +
                        `less than the ${damagedGrams} g damaged. Resolve the stock discrepancy first — negative stock is never allowed (GT-03).`,
                );
            }
            await this.productStockService.setProductStock(ctx, line.productId, locationId, current - damagedGrams);
            result = { lineId: line.id, productName: line.productName, path: 'pool', oldValue: current, newValue: current - damagedGrams };
            const variants = await this.connection
                .getRepository(ctx, ProductVariant)
                .find({ where: { productId: line.productId as any, deletedAt: IsNull() } });
            await this.eventBus.publish(new ProductVariantEvent(ctx, variants, 'updated'));
        } else {
            if (!line.productVariantId || damagedPcs == null || damagedPcs <= 0) {
                throw new UserInputError('damagedPcs must be positive for a PCS product');
            }
            const before = await this.stockLevelService.getStockLevel(ctx, line.productVariantId, locationId);
            const current = before?.stockOnHand ?? 0;
            if (current - damagedPcs < 0) {
                throw new UserInputError(
                    `Cannot approve damage: current ${branch} stock of "${line.productName}" is ${current}, ` +
                        `less than the ${damagedPcs} damaged. Resolve the stock discrepancy first — negative stock is never allowed (GT-03).`,
                );
            }
            await this.stockLevelService.updateStockOnHandForLocation(ctx, line.productVariantId, locationId, -damagedPcs);
            result = { lineId: line.id, productName: line.productName, path: 'variant', oldValue: current, newValue: current - damagedPcs };
            const variant = await this.connection
                .getRepository(ctx, ProductVariant)
                .findOne({ where: { id: line.productVariantId as any } });
            if (variant) {
                await this.eventBus.publish(new ProductVariantEvent(ctx, [variant], 'updated'));
            }
        }
        return result;
    }

    /**
     * Read-only: what the destination holds of this line's product right now.
     * Base units for pooled products (grams, millilitres or pieces — the line's
     * poolUnit says which), pieces otherwise. The same figures the write paths above
     * operate on, so a screen and an approval never disagree.
     */
    async getCurrentStock(ctx: RequestContext, line: GoodsTransferLine, locationId: ID): Promise<number> {
        if (line.isPooled) {
            const levels = await this.productStockService.getProductStockLevels(ctx, line.productId);
            return levels.find(l => String(l.stockLocationId) === String(locationId))?.stockOnHand ?? 0;
        }
        if (!line.productVariantId) {
            return 0;
        }
        const level = await this.stockLevelService.getStockLevel(ctx, line.productVariantId, locationId);
        return level?.stockOnHand ?? 0;
    }

    // ------------------------------------------------------------ classify

    /**
     * Route each line by the LIVE pool flag, cross-checked against the line's
     * snapshot. Mismatch (product reclassified since dispatch) aborts a damage
     * approval with a named message — never guess. Receipt does not call this for
     * a mismatched line; it skips the line instead (see applyLines).
     *
     * The pool's UNIT is checked the same way and for the same reason. The unit is
     * derived from the product's measurement option, so an option group edited while
     * the goods were in a vehicle would silently reinterpret a number already printed
     * on the paperwork — thirty lemons becoming thirty grams. Refusing is the only
     * safe answer: the figure on the document and the figure about to be posted must
     * mean the same thing.
     *
     * A line written before units were recorded has no snapshot to compare, and is
     * let through on the live unit. Nothing is lost by that — those rows were already
     * being posted on the assumption that every pool was grams.
     */
    private async classifyLine(
        ctx: RequestContext,
        line: GoodsTransferLine,
    ): Promise<{ livePooled: boolean }> {
        const mismatch = await this.lineMismatch(ctx, line);
        if (mismatch) {
            throw new UserInputError(
                `${mismatch} Approval blocked — the Admin Team must review this product before it can be approved.`,
            );
        }
        return { livePooled: line.isPooled };
    }

    /**
     * Why this line no longer matches its product, or null when it still does.
     * The checks classifyLine enforces, as a value — receipt reports them per line
     * instead of refusing the transfer.
     */
    private async lineMismatch(ctx: RequestContext, line: GoodsTransferLine): Promise<string | null> {
        const product = await this.connection
            .getRepository(ctx, Product)
            .findOne({ where: { id: line.productId as any } });
        if (!product) {
            throw new UserInputError(`Product for line "${line.productName}" no longer exists`);
        }
        const v = (product.customFields as { productStockEnabled?: boolean | number | string } | undefined)
            ?.productStockEnabled;
        const livePooled = v === true || v === 1 || v === '1';
        if (livePooled !== line.isPooled) {
            return `Product "${line.productName}" changed stock type (pool vs piece) since dispatch.`;
        }
        if (livePooled && line.poolUnit != null) {
            const liveUnit = await this.poolUnitForProduct(ctx, line.productId);
            if (liveUnit !== line.poolUnit) {
                return (
                    `Product "${line.productName}" changed measurement unit since dispatch ` +
                    `(sent in ${poolUnitSuffix(line.poolUnit)}, now measured in ${poolUnitSuffix(liveUnit)}).`
                );
            }
        }
        return null;
    }

    /** What this product's pool is counted in right now. See pool-unit.helper.ts. */
    private async poolUnitForProduct(ctx: RequestContext, productId: ID): Promise<string> {
        const units = await poolUnitsForProducts(ctx, this.connection, [productId]);
        return units.get(String(productId)) ?? DEFAULT_POOL_UNIT;
    }

    // ------------------------------------------------------ variant (PCS)

    /** Adds a PCS line's pieces to the destination location (GT-02). Additive only. */
    private async addVariantLine(
        ctx: RequestContext,
        line: GoodsTransferLine,
        locationId: ID,
    ): Promise<LineStockResult> {
        if (!line.productVariantId || line.quantityPcs == null) {
            throw new UserInputError(`Line "${line.productName}" is not a valid PCS line`);
        }
        const before = await this.stockLevelService.getStockLevel(ctx, line.productVariantId, locationId);
        const oldValue = before?.stockOnHand ?? 0;

        // Delta-based, matching the production location-stock tool: read the current
        // value, hand core the difference. There is no negative guard here because
        // receipt only ever adds — deductDamage owns every deduction and its guard.
        await this.stockLevelService.updateStockOnHandForLocation(
            ctx,
            line.productVariantId,
            locationId,
            line.quantityPcs,
        );
        return {
            lineId: line.id,
            productName: line.productName,
            path: 'variant',
            oldValue,
            newValue: oldValue + line.quantityPcs,
        };
    }

    // --------------------------------------------------------- pool (base units)

    /**
     * Adds a pool line's quantity to the destination pool (GT-02). Additive only.
     *
     * Unit-agnostic by construction: both sides of the sum are integers in the same
     * base, whatever that base is. The unit was settled when the line was entered and
     * re-checked in classifyLine, so there is nothing to convert here — which is
     * exactly why the old kg assumption did its damage further upstream, at entry,
     * rather than in this addition.
     */
    private async addPoolLine(
        ctx: RequestContext,
        line: GoodsTransferLine,
        locationId: ID,
    ): Promise<LineStockResult> {
        if (line.weightGrams == null) {
            throw new UserInputError(`Line "${line.productName}" is not a valid pool line`);
        }
        const levels = await this.productStockService.getProductStockLevels(ctx, line.productId);
        const current = levels.find(l => String(l.stockLocationId) === String(locationId))?.stockOnHand ?? 0;
        const target = current + line.weightGrams;

        // setProductStock is absolute — compute the target from the value just read
        // and write it inside this locked transaction; it re-derives every variant's
        // display level from the pool.
        await this.productStockService.setProductStock(ctx, line.productId, locationId, target);
        return {
            lineId: line.id,
            productName: line.productName,
            path: 'pool',
            oldValue: current,
            newValue: target,
        };
    }

    // ------------------------------------------------------------- naming

    /**
     * The destination branch's name, for messages read at that branch.
     * Resolved through TransferChannelService so a branch is named one way, and never
     * hardcoded — a hardcoded name is correct in one branch and wrong in every other.
     */
    private destinationName(ctx: RequestContext, transfer: GoodsTransfer): Promise<string> {
        return this.channelService.getChannelCode(ctx, transfer.destinationChannelId);
    }
}
