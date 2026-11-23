import { OnApplicationBootstrap, Injectable, OnModuleInit } from '@nestjs/common';
import {
    EventBus,
    ProductVariantEvent,
    PluginCommonModule,
    VendurePlugin,
    OrderService,
    TransactionalConnection,
    Order,
    OrderLine,
    RequestContext,
    Logger,
    ID,
    JobQueue,
    JobQueueService,
    RequestContextService,
    ProductVariant,
    idsAreEqual,
    HistoryService,
    Ctx,
    Allow,
    Permission,
} from '@vendure/core';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { LanguageCode } from '@vendure/core';
import gql from 'graphql-tag';
import path from 'path';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import { PriceUpdateInterceptor } from './config/price-update.interceptor';
import { PriceUpdateOrderEntityResolver } from './api/order-entity.resolver';
import { ORDER_LINE_PRICE_UPDATED } from './history-entry.constant';
import { PriceSyncQueueItem } from './entities/price-sync-queue-item.entity';
import { PriceSyncBatch } from './entities/price-sync-batch.entity';
import { PriceSyncHealthService } from './services/price-sync-health.service';
import { backoffMs, inputCouldChangePrice, mapWithConcurrency } from './services/price-sync.util';
import { pickOrderSyncChannelId, resolveCurrentChannelPrice } from './services/price-sync-plan.util';
import { lockOrderAndReadState, REPRICEABLE_STATE } from './services/price-lock.util';
import { priceSyncDrainTask } from './tasks/price-sync-drain.task';

interface PriceUpdateJobData {
    variantIds: ID[];
    variantPrices: Record<ID, number>;
    channelToken: string;
    languageCode?: LanguageCode;
    priority?: 'high' | 'low';
}

/**
 * Sum of `unitPrice × quantity` across every selection in an OrderLine's
 * `addonSelections` JSON snapshot. Returns 0 when the snapshot is missing or
 * unparseable. Used to keep listPrice comparisons addon-aware so the
 * `PriceUpdateInterceptor` doesn't reset addon-baked listPrices back to the
 * bare variant price on every read.
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

interface OrderLinePriceUpdateLog {
    orderLineId: ID;
    variantId: ID;
    previousUnitPrice: number;
    newUnitPrice: number;
}

const priceUpdateHistorySchema = gql`
    extend enum HistoryEntryType {
        ORDER_LINE_PRICE_UPDATED
    }
`;

const priceUpdateAdminSchema = gql`
    extend enum HistoryEntryType {
        ORDER_LINE_PRICE_UPDATED
    }

    type PriceSyncBatch {
        id: ID!
        createdAt: DateTime!
        channelCode: String!
        variantCount: Int!
        affectedOrders: Int!
        syncedNow: Int!
        queuedCount: Int!
    }

    type PriceSyncBatchList {
        items: [PriceSyncBatch!]!
        totalItems: Int!
        "Orders still awaiting the background drain right now."
        pendingInQueue: Int!
    }

    input PriceSyncBatchOptions {
        skip: Int
        take: Int
    }

    extend type Query {
        "SuperAdmin-only history of price-update order-sync fan-out, newest first."
        priceSyncBatches(options: PriceSyncBatchOptions): PriceSyncBatchList!
    }
`;

interface PriceSyncConfig {
    activeWindowMin: number;
    activeCap: number;
    activeConcurrency: number;
    drainBatch: number;
    drainConcurrency: number;
    maxAttempts: number;
    claimStaleMin: number;
}

/** All bounds are env-tunable so ops can throttle without a redeploy. */
function readPriceSyncConfig(): PriceSyncConfig {
    return {
        // An order updated within this many minutes = a live shopper -> sync now.
        activeWindowMin: Number(process.env.PRICE_SYNC_ACTIVE_WINDOW_MIN ?? '15'),
        activeCap: Number(process.env.PRICE_SYNC_ACTIVE_CAP ?? '50'),
        activeConcurrency: Number(process.env.PRICE_SYNC_ACTIVE_CONCURRENCY ?? '5'),
        drainBatch: Number(process.env.PRICE_SYNC_DRAIN_BATCH ?? '25'),
        drainConcurrency: Number(process.env.PRICE_SYNC_DRAIN_CONCURRENCY ?? '3'),
        maxAttempts: Number(process.env.PRICE_SYNC_MAX_ATTEMPTS ?? '5'),
        // A `processing` row older than this (worker crashed mid-item) is reclaimed.
        claimStaleMin: Number(process.env.PRICE_SYNC_CLAIM_STALE_MIN ?? '10'),
    };
}

@Injectable()
export class PriceUpdateService implements OnModuleInit, OnApplicationBootstrap {
    private priceUpdateQueue: JobQueue<PriceUpdateJobData>;
    private lazyUpdateQueue: JobQueue<PriceUpdateJobData>;

    // Manual 2s buffer for variant-update events. Replaces an rxjs `.pipe(bufferTime)`
    // that imported operators from the app's rxjs copy and piped them onto Vendure's
    // EventBus observable (a *different* rxjs copy). Mixing two rxjs copies throws
    // "You provided an invalid object where a stream was expected" and crashed the
    // process. Buffering in plain JS keeps everything inside Vendure's own rxjs.
    private variantEventBuffer: ProductVariantEvent[] = [];
    private variantFlushTimer: NodeJS.Timeout | null = null;

    constructor(
        private eventBus: EventBus,
        private orderService: OrderService,
        private connection: TransactionalConnection,
        private jobQueueService: JobQueueService,
        private requestContextService: RequestContextService,
        private historyService: HistoryService,
        private healthService: PriceSyncHealthService,
    ) {}

    async onModuleInit() {
        // High priority queue for active users (when they access cart)
        this.priceUpdateQueue = await this.jobQueueService.createQueue({
            name: 'update-product-prices-active',
            process: async (job) => {
                return await this.processPriceUpdate(job, true);
            },
        });

        // Low priority queue for inactive orders (background processing)
        this.lazyUpdateQueue = await this.jobQueueService.createQueue({
            name: 'update-product-prices-inactive',
            process: async (job) => {
                return await this.processPriceUpdate(job, false);
            },
        });
    }

    onApplicationBootstrap() {
        // Buffer variant-update events over a 2s window and UNION their variant
        // ids into one pass (union, not debounce: a debounce would keep only the
        // LAST event of a burst and silently drop every other changed variant).
        // The subscribe callback is SYNCHRONOUS and wrapped, so a fault here can
        // never surface as an unhandled rejection that kills the process.
        this.eventBus.ofType(ProductVariantEvent).subscribe(event => {
            try {
                if (event.type !== 'updated') {
                    return;
                }
                // ProductVariantEvent fires for ANY variant edit -- a weight
                // custom field, a stock location, a facet. Fanning a price
                // re-sync across every active order for those is pure waste:
                // between 5-6 Aug 2026, 32 batches ran (up to 1096 orders each)
                // with no price changed since 11 July. The input is a patch, so
                // an absent `price`/`prices` key proves none was submitted.
                // Fails open -- see inputCouldChangePrice.
                if (!inputCouldChangePrice(event.input)) {
                    return;
                }
                this.variantEventBuffer.push(event);
                if (this.variantFlushTimer === null) {
                    this.variantFlushTimer = setTimeout(() => this.flushVariantEvents(), 2000);
                    // Don't let the buffer timer keep the process alive on shutdown.
                    this.variantFlushTimer.unref?.();
                }
            } catch (e: any) {
                Logger.error(`Failed to buffer variant update: ${e?.message}`, 'PriceUpdatePlugin', e?.stack);
            }
        });
    }

    /** Flush the 2s buffer: drain the collected events and fan them out once. */
    private flushVariantEvents(): void {
        this.variantFlushTimer = null;
        const events = this.variantEventBuffer;
        this.variantEventBuffer = [];
        if (events.length === 0) {
            return;
        }
        // Fire-and-forget: handleVariantUpdates catches its own errors, but guard
        // the promise too so a rejection can never become an unhandled rejection.
        void this.handleVariantUpdates(events).catch((e: any) =>
            Logger.error(`Failed to handle buffered variant updates: ${e?.message}`, 'PriceUpdatePlugin', e?.stack),
        );
    }

    /**
     * Called when customer accesses their cart/order
     * Updates prices immediately for active user (lazy update)
     */
    async updatePricesForActiveOrder(
        ctx: RequestContext,
        orderId: ID
    ): Promise<Order | null> {
        try {
            const order = await this.orderService.findOne(ctx, orderId, [
                'lines',
                'lines.productVariant',
                'channels',
            ]);

            if (!order || !order.active) {
                return null;
            }
            // Price lock: an order the customer is paying for keeps its price.
            if (order.state !== REPRICEABLE_STATE) {
                return order;
            }

            // Find variants with price changes
            const priceChanges = await this.findPriceChanges(ctx, order);

            if (priceChanges.length === 0) {
                return order; // No changes, return as-is
            }

            // Update immediately for active user
            const variantPrices: Record<ID, number> = {};
            priceChanges.forEach(change => {
                variantPrices[change.variantId] = change.newPrice;
            });

            const updatedOrder = await this.updateOrderPricesOptimized(ctx, order, variantPrices);

            const finalOrder = updatedOrder ?? (await this.orderService.findOne(ctx, orderId));

            Logger.info(
                `Lazy update: Updated prices for active order ${order.code} (${priceChanges.length} variants changed)`,
                'PriceUpdatePlugin'
            );

            return finalOrder || null;
        } catch (e: any) {
            Logger.error(
                `Failed to update prices for active order ${orderId}: ${e.message}`,
                'PriceUpdatePlugin'
            );
            // Return original order on error
            const fallbackOrder = await this.orderService.findOne(ctx, orderId);
            return fallbackOrder || null;
        }
    }

    /**
     * On a (buffered) batch of variant price updates: count the blast radius,
     * sync only the mid-checkout orders immediately, and queue the rest for the
     * health-gated drain. Replaces the old "load every affected order and recalc
     * 20-at-a-time" job that starved the shared DB pool and downed the server.
     */
    private async handleVariantUpdates(events: ProductVariantEvent[]) {
        const ctx = events[0].ctx;
        try {
            // Union changed variants + their latest price across the whole window.
            const variantPrices: Record<ID, number> = {};
            for (const event of events) {
                for (const variant of event.entity) {
                    variantPrices[variant.id] = variant.price;
                }
            }
            const variantIds = Object.keys(variantPrices);
            if (variantIds.length === 0) {
                return;
            }
            // Count-first: know how many orders are affected before doing any work.
            const refs = await this.findActiveOrderRefs(ctx, variantIds);
            // Priority by RECENCY: every order found here is a cart (AddingItems), so
            // urgent = touched within the active window (a live shopper); everything
            // else drains slowly. Mid-payment orders are never repriced (price lock).
            const config = readPriceSyncConfig();
            const cutoff = Date.now() - config.activeWindowMin * 60_000;
            const isUrgent = (r: { state: string; updatedAt: Date }): boolean =>
                new Date(r.updatedAt).getTime() >= cutoff;
            const urgent = refs.filter(isUrgent).map(r => r.id);
            const rest = refs.filter(r => !isUrgent(r)).map(r => r.id);
            Logger.info(
                `Price update: ${variantIds.length} variant(s) touch ${refs.length} active order(s) ` +
                    `(${urgent.length} active-now → sync, ${rest.length} → queued)`,
                'PriceUpdatePlugin',
            );
            // Stamp each order with ITS OWN channel token so the sync recomputes it
            // in the city channel it belongs to, not the master channel (bugs C1/C2).
            const tokenByOrder = await this.resolveOwnChannelTokens(ctx, refs.map(r => r.id));
            const toRow = (id: ID) => ({
                orderId: id,
                channelToken: tokenByOrder.get(`${id}`) ?? ctx.channel.token,
            });
            // Priority: live shoppers get correct prices immediately (bounded).
            await this.syncActiveCheckoutOrders(ctx, urgent.map(toRow));
            // Everyone else drains slowly, health-gated, via the scheduled task.
            await this.enqueueOrders(ctx, rest.map(toRow));
            // Persist the fan-out so the PWA Price History can show sync activity.
            const syncedNow = Math.min(urgent.length, config.activeCap);
            const queuedCount = rest.length + Math.max(0, urgent.length - config.activeCap);
            await this.recordSyncBatch(ctx, {
                variantCount: variantIds.length,
                affectedOrders: refs.length,
                syncedNow,
                queuedCount,
            });
        } catch (e: any) {
            Logger.error(`Failed to schedule price sync: ${e.message}`, 'PriceUpdatePlugin', e.stack);
        }
    }

    /** Minimal (id, state, updatedAt) of active CARTS touching any variant — no hydration.
     * Orders past AddingItems are excluded: their price is locked (see price-lock.util). */
    private async findActiveOrderRefs(
        ctx: RequestContext,
        variantIds: ID[],
    ): Promise<Array<{ id: ID; state: string; updatedAt: Date }>> {
        return this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('o')
            .innerJoin('o.lines', 'l')
            .select('o.id', 'id')
            .addSelect('o.state', 'state')
            .addSelect('o.updatedAt', 'updatedAt')
            .distinct(true)
            .where('o.active = :active', { active: true })
            .andWhere('o.state = :state', { state: REPRICEABLE_STATE })
            .andWhere('l.productVariantId IN (:...variantIds)', { variantIds })
            .getRawMany<{ id: ID; state: string; updatedAt: Date }>();
    }

    /**
     * Map each order id to the token of its OWN (non-default) channel. A Vendure
     * order belongs to the default channel plus its city channel; recomputing it
     * in the default channel reads the master price and corrupts the line (C1/C2).
     * Orders that live only in the default channel are omitted (caller falls back
     * to the current ctx token). Uses the `o.channels` relation so TypeORM resolves
     * the join table — no hardcoded table name.
     */
    private async resolveOwnChannelTokens(
        ctx: RequestContext,
        orderIds: ID[],
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        if (orderIds.length === 0) {
            return result;
        }
        const rows: Array<{ orderId: ID; channelId: ID; token: string; code: string }> =
            await this.connection
                .getRepository(ctx, Order)
                .createQueryBuilder('o')
                .innerJoin('o.channels', 'c')
                .select('o.id', 'orderId')
                .addSelect('c.id', 'channelId')
                .addSelect('c.token', 'token')
                .addSelect('c.code', 'code')
                .where('o.id IN (:...orderIds)', { orderIds })
                .getRawMany();
        const defaultChannelId = rows.find(r => r.code === '__default_channel__')?.channelId ?? '';
        const channelsByOrder = new Map<string, Array<{ channelId: ID; token: string }>>();
        for (const row of rows) {
            const key = `${row.orderId}`;
            const list = channelsByOrder.get(key) ?? [];
            list.push({ channelId: row.channelId, token: row.token });
            channelsByOrder.set(key, list);
        }
        for (const [orderId, channels] of channelsByOrder) {
            const ownId = pickOrderSyncChannelId(channels.map(c => c.channelId), defaultChannelId);
            const own = channels.find(c => `${c.channelId}` === `${ownId}`);
            if (own) {
                result.set(orderId, own.token);
            }
        }
        return result;
    }

    /** Recompute prices immediately for live-shopper orders, bounded + capped concurrency.
     * Each order is recomputed in its OWN channel context (grouped by token) so a
     * city order reads the city price, not the master price (C1/C2). */
    private async syncActiveCheckoutOrders(
        ctx: RequestContext,
        rows: Array<{ orderId: ID; channelToken: string }>,
    ): Promise<void> {
        if (rows.length === 0) {
            return;
        }
        const config = readPriceSyncConfig();
        const capped = rows.slice(0, config.activeCap);
        if (capped.length < rows.length) {
            Logger.warn(
                `Active-now orders (${rows.length}) exceed cap ${config.activeCap}; ` +
                    `deferring ${rows.length - capped.length} to the queue`,
                'PriceUpdatePlugin',
            );
            await this.enqueueOrders(ctx, rows.slice(config.activeCap));
        }
        const byToken = new Map<string, Array<{ orderId: ID; channelToken: string }>>();
        for (const row of capped) {
            const list = byToken.get(row.channelToken) ?? [];
            list.push(row);
            byToken.set(row.channelToken, list);
        }
        for (const [token, items] of byToken) {
            const tokenCtx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: token,
                languageCode: LanguageCode.en,
            });
            await mapWithConcurrency(items, config.activeConcurrency, async row => {
                await this.updatePricesForActiveOrder(tokenCtx, row.orderId);
            });
        }
    }

    /** Upsert one `pending` row per order (re-arms existing rows). Chunked to stay under packet limits.
     * Stores each order's OWN channel token so the drain recomputes it in the right channel. */
    private async enqueueOrders(
        ctx: RequestContext,
        rows: Array<{ orderId: ID; channelToken: string }>,
    ): Promise<void> {
        if (rows.length === 0) {
            return;
        }
        const repo = this.connection.getRepository(ctx, PriceSyncQueueItem);
        for (let i = 0; i < rows.length; i += 500) {
            const slice = rows.slice(i, i + 500);
            const valuesSql = slice.map(() => '(?, ?, ?, 0, NULL, NULL, NULL, NULL)').join(', ');
            const params: any[] = [];
            for (const row of slice) {
                params.push(row.orderId, row.channelToken, 'pending');
            }
            await repo.query(
                'INSERT INTO `price_sync_queue_item` ' +
                    '(`orderId`, `channelToken`, `status`, `attempts`, `nextRunAt`, `claimedAt`, `claimedBy`, `lastError`) ' +
                    `VALUES ${valuesSql} ` +
                    'ON DUPLICATE KEY UPDATE ' +
                    '`channelToken` = VALUES(`channelToken`), ' +
                    "`status` = 'pending', `attempts` = 0, `nextRunAt` = NULL, " +
                    '`claimedAt` = NULL, `claimedBy` = NULL, `lastError` = NULL, ' +
                    '`updatedAt` = CURRENT_TIMESTAMP(6)',
                params,
            );
        }
    }

    /** Persist one fan-out summary row (best-effort; never blocks the price update). */
    private async recordSyncBatch(
        ctx: RequestContext,
        counts: {
            variantCount: number;
            affectedOrders: number;
            syncedNow: number;
            queuedCount: number;
        },
    ): Promise<void> {
        try {
            await this.connection.getRepository(ctx, PriceSyncBatch).save(
                new PriceSyncBatch({
                    channelToken: ctx.channel.token,
                    channelCode: ctx.channel.code,
                    ...counts,
                }),
            );
        } catch (e: any) {
            Logger.warn(`Failed to record sync batch: ${e.message}`, 'PriceUpdatePlugin');
        }
    }

    /** Recent sync-fan-out rows (newest first) + the live pending-in-queue count. */
    async getSyncBatches(
        ctx: RequestContext,
        options: { skip?: number; take?: number } = {},
    ): Promise<{ items: PriceSyncBatch[]; totalItems: number; pendingInQueue: number }> {
        const [items, totalItems] = await this.connection
            .getRepository(ctx, PriceSyncBatch)
            .createQueryBuilder('b')
            .orderBy('b.createdAt', 'DESC')
            .skip(options.skip ?? 0)
            .take(Math.min(options.take ?? 25, 100))
            .getManyAndCount();
        const pendingInQueue = await this.connection
            .getRepository(ctx, PriceSyncQueueItem)
            .count({ where: { status: 'pending' } });
        return { items, totalItems, pendingInQueue };
    }

    /**
     * Scheduled drain entry point. Only runs when the server is healthy; claims a
     * small batch, processes each order in ITS channel's context with a hard
     * concurrency cap, and retries failures with backoff. Cannot starve the pool.
     */
    async drainQueue(): Promise<{ processed: number; failed: number; skipped: boolean }> {
        const health = await this.healthService.check();
        if (!health.healthy) {
            return { processed: 0, failed: 0, skipped: true };
        }
        const config = readPriceSyncConfig();
        const claimed = await this.claimBatch(config.drainBatch);
        if (claimed.length === 0) {
            return { processed: 0, failed: 0, skipped: false };
        }
        Logger.info(`Draining ${claimed.length} queued order(s)`, 'PriceUpdatePlugin');
        const byChannel = new Map<string, typeof claimed>();
        for (const item of claimed) {
            const list = byChannel.get(item.channelToken) ?? [];
            list.push(item);
            byChannel.set(item.channelToken, list);
        }
        let processed = 0;
        let failed = 0;
        for (const [token, items] of byChannel) {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: token,
                languageCode: LanguageCode.en,
            });
            await mapWithConcurrency(items, config.drainConcurrency, async item => {
                try {
                    await this.updatePricesForActiveOrder(ctx, item.orderId);
                    await this.markSynced(ctx, item.id);
                    processed++;
                } catch (e: any) {
                    failed++;
                    await this.markFailure(
                        ctx,
                        item.id,
                        item.attempts,
                        config.maxAttempts,
                        e?.message ?? 'unknown',
                    );
                }
            });
        }
        Logger.info(`Drain complete: ${processed} synced, ${failed} failed`, 'PriceUpdatePlugin');
        return { processed, failed, skipped: false };
    }

    /** Claim up to `batchSize` pending rows using FOR UPDATE SKIP LOCKED (multi-worker safe).
     * Also reclaims `processing` rows abandoned by a crashed worker (older than
     * `claimStaleMin`), so a mid-item crash can never strand an order forever (W4). */
    private async claimBatch(
        batchSize: number,
    ): Promise<Array<{ id: number; orderId: ID; channelToken: string; attempts: number }>> {
        const limit = Math.max(1, Math.min(500, Math.floor(batchSize)));
        const claimedBy = `pid-${process.pid}`;
        const staleMin = Math.max(1, Math.floor(readPriceSyncConfig().claimStaleMin));
        return this.connection.rawConnection.transaction(async manager => {
            const rows: Array<{ id: number; orderId: ID; channelToken: string; attempts: number }> =
                await manager.query(
                    'SELECT `id`, `orderId`, `channelToken`, `attempts` FROM `price_sync_queue_item` ' +
                        "WHERE (`status` = 'pending' AND (`nextRunAt` IS NULL OR `nextRunAt` <= NOW())) " +
                        "   OR (`status` = 'processing' AND `claimedAt` < DATE_SUB(NOW(), INTERVAL ? MINUTE)) " +
                        `ORDER BY \`createdAt\` ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED`,
                    [staleMin],
                );
            if (rows.length === 0) {
                return [];
            }
            const ids = rows.map(r => r.id);
            await manager.query(
                "UPDATE `price_sync_queue_item` SET `status` = 'processing', `claimedAt` = NOW(), `claimedBy` = ? " +
                    `WHERE \`id\` IN (${ids.map(() => '?').join(',')})`,
                [claimedBy, ...ids],
            );
            return rows;
        });
    }

    private async markSynced(ctx: RequestContext, id: number): Promise<void> {
        // Guard on status+claimedBy: if a fresh price change re-armed this row to
        // `pending` while we were processing, this update matches nothing and the
        // re-arm survives to be reprocessed — no lost update (W3).
        await this.connection
            .getRepository(ctx, PriceSyncQueueItem)
            .createQueryBuilder()
            .update()
            .set({ status: 'done', lastError: null, claimedAt: null, claimedBy: null })
            .where('id = :id', { id })
            .andWhere('status = :processing', { processing: 'processing' })
            .andWhere('claimedBy = :cb', { cb: `pid-${process.pid}` })
            .execute();
    }

    private async markFailure(
        ctx: RequestContext,
        id: number,
        attempts: number,
        maxAttempts: number,
        message: string,
    ): Promise<void> {
        const nextAttempts = attempts + 1;
        const exhausted = nextAttempts >= maxAttempts;
        // Same guard as markSynced: never clobber a concurrent re-arm (W3).
        await this.connection
            .getRepository(ctx, PriceSyncQueueItem)
            .createQueryBuilder()
            .update()
            .set({
                status: exhausted ? 'failed' : 'pending',
                attempts: nextAttempts,
                nextRunAt: exhausted ? null : new Date(Date.now() + backoffMs(nextAttempts)),
                claimedAt: null,
                claimedBy: null,
                lastError: message.slice(0, 1000),
            })
            .where('id = :id', { id })
            .andWhere('status = :processing', { processing: 'processing' })
            .andWhere('claimedBy = :cb', { cb: `pid-${process.pid}` })
            .execute();
    }

    private async findPriceChanges(
        ctx: RequestContext,
        order: Order
    ): Promise<Array<{ variantId: ID; newPrice: number }>> {
        const variantIds = order.lines.map(line => line.productVariant.id);
        
        if (variantIds.length === 0) {
            return [];
        }

        Logger.debug(
            `Checking price changes for order ${order.code}, variants: ${variantIds.join(', ')}`,
            'PriceUpdatePlugin'
        );

        // Get current prices from ProductVariant with proper channel filtering
        const variants = await this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.productVariantPrices', 'prices')
            .where('variant.id IN (:...variantIds)', { variantIds })
            .getMany();

        const changes: Array<{ variantId: ID; newPrice: number }> = [];

        for (const variant of variants) {
            const orderLine = order.lines.find(l => l.productVariant.id === variant.id);
            if (!orderLine) {
                Logger.debug(`OrderLine not found for variant ${variant.id}`, 'PriceUpdatePlugin');
                continue;
            }

            // Find price for the current channel
            const channelPrice = variant.productVariantPrices?.find(
                p => (p as any).channelId === ctx.channelId
            );
            
            // Get current price - prefer channel-specific price, fallback to variant.price.
            // Null-check the ROW, not the number: a legit ₹0 channel price must win (W1).
            const currentPrice = resolveCurrentChannelPrice(channelPrice, variant.price);
            const orderPrice = orderLine.unitPrice;

            // Addon-aware: the line's listPrice is set by AddonPriceCalculationStrategy
            // to (variantPrice + Σ addon contribution). Compare against the addon-inclusive
            // expected value, not the bare variant price — otherwise every read flags
            // the line as "wrong" and resets it back to the variant price.
            const addonContribution = getAddonContributionPerUnit(
                (orderLine.customFields as any)?.addonSelections,
            );
            const expectedListPrice = currentPrice + addonContribution;

            Logger.debug(
                `Variant ${variant.id}: Order price=${orderPrice}, Expected=${expectedListPrice} (base ${currentPrice} + addons ${addonContribution}), Channel=${ctx.channelId}`,
                'PriceUpdatePlugin'
            );

            // If the line's listPrice differs from the addon-inclusive expected
            // value, queue an update with newPrice = base variant price (the
            // consumer adds addon contribution back per-line on write).
            if (expectedListPrice !== orderPrice) {
                // Silenced pending review of the PriceUpdatePlugin mismatch flow (2026-07-14).
                // Detection + queued correction below are UNCHANGED — only the log is muted.
                // Logger.info(
                //     `Price mismatch detected for variant ${variant.id} in order ${order.code}: ${orderPrice} -> ${expectedListPrice} (base ${currentPrice} + addons ${addonContribution})`,
                //     'PriceUpdatePlugin'
                // );
                changes.push({
                    variantId: variant.id,
                    newPrice: currentPrice,
                });
            }
        }

        Logger.debug(
            `Found ${changes.length} price changes for order ${order.code}`,
            'PriceUpdatePlugin'
        );

        return changes;
    }

    private async updateOrderPricesOptimized(
        ctx: RequestContext,
        order: Order,
        variantPrices: Record<ID, number>
    ): Promise<Order | null> {
        const priceChanges = order.lines
            .map<OrderLinePriceUpdateLog | null>((line) => {
                const baseNewPrice = variantPrices[line.productVariant.id];
                if (baseNewPrice === undefined) {
                    return null;
                }

                // Addon-aware target price: add the line's addon contribution
                // on top of the variant's base price so addons aren't stripped
                // when this writes back to `order_line.listPrice`.
                const addonContribution = getAddonContributionPerUnit(
                    (line.customFields as any)?.addonSelections,
                );
                const newUnitPrice = baseNewPrice + addonContribution;

                const currentPrice = line.unitPrice;
                if (currentPrice === newUnitPrice) {
                    return null;
                }

                return {
                    orderLineId: line.id,
                    variantId: line.productVariant.id,
                    previousUnitPrice: currentPrice,
                    newUnitPrice,
                };
            })
            .filter((change): change is OrderLinePriceUpdateLog => change !== null);

        if (priceChanges.length === 0) {
            return null;
        }

        // OPTIMIZATION: Bulk UPDATE using CASE statement
        const whenCases = priceChanges
            .map((change) => `WHEN ${change.orderLineId} THEN ${change.newUnitPrice}`)
            .join(' ');
        
        const orderLineIds = priceChanges.map(change => change.orderLineId);

        // Atomic: the listPrice write and the totals recalc must commit together.
        // If applyPriceAdjustments throws a real error, the listPrice write rolls
        // back so the next pass re-detects the delta — instead of leaving totals
        // permanently stale against an already-updated line (W2). A tax-zone error
        // is swallowed inside recalculateOrderTotals, so that path still commits.
        return this.connection.withTransaction(ctx, async txCtx => {
            // The order may have moved to ArrangingPayment since it was read above
            // (the customer tapped Pay). Re-check under the row lock; abort if so.
            if ((await lockOrderAndReadState(this.connection, txCtx, order.id)) !== REPRICEABLE_STATE) {
                return null;
            }
            await this.connection
                .getRepository(txCtx, OrderLine)
                .createQueryBuilder()
                .update()
                .set({
                    listPrice: () => `CASE id ${whenCases} END`
                })
                .where('id IN (:...orderLineIds)', { orderLineIds })
                .andWhere('orderId = :orderId', { orderId: order.id })
                .execute();
            return this.recalculateOrderTotals(txCtx, order.id, priceChanges);
        });
    }

    private async recalculateOrderTotals(
        ctx: RequestContext,
        orderId: ID,
        priceChanges: OrderLinePriceUpdateLog[],
    ): Promise<Order | null> {
        let order: Order | undefined;
        let orderIdentifier: string | ID = orderId;

        try {
            const relations = [
                'lines',
                'lines.productVariant',
                'shippingLines',
                'surcharges',
                'channels',
            ] as const;

            order = await this.orderService.findOne(ctx, orderId, relations as any);

            if (!order) {
                return null;
            }

            orderIdentifier = order.code ?? orderId;

            let updatedLines = order.lines.filter(line =>
                priceChanges.some(change => idsAreEqual(line.id, change.orderLineId))
            );

            if (updatedLines.length === 0 && priceChanges.length > 0) {
                Logger.debug(
                    `Updated order lines not matched for order ${orderIdentifier}. Recalculating all lines as fallback`,
                    'PriceUpdatePlugin'
                );
                updatedLines = order.lines;
            }

            if (updatedLines.length === 0) {
                return order;
            }

            const recalculatedOrder = await this.orderService.applyPriceAdjustments(
                ctx,
                order,
                updatedLines as any,
            );

            await this.recordPriceUpdateHistory(ctx, orderId, order, priceChanges);

            Logger.debug(
                `Recalculated totals for order ${orderIdentifier}. Subtotal=${recalculatedOrder.subTotal}, Total=${recalculatedOrder.total}`,
                'PriceUpdatePlugin'
            );
            return recalculatedOrder;
        } catch (error: any) {
            if (error?.message?.includes('no-active-tax-zone')) {
                Logger.debug(
                    `Price updated for order ${orderIdentifier} but totals not recalculated (no tax zone configured)`,
                    'PriceUpdatePlugin'
                );
                return order ?? (await this.orderService.findOne(ctx, orderId)) ?? null;
            }

            Logger.error(
                `Failed to recalculate totals for order ${orderIdentifier}: ${error?.message}`,
                'PriceUpdatePlugin',
                error?.stack
            );
            throw error;
        }
    }

    private async recordPriceUpdateHistory(
        ctx: RequestContext,
        orderId: ID,
        order: Order,
        priceChanges: OrderLinePriceUpdateLog[],
    ): Promise<void> {
        if (!priceChanges.length) {
            return;
        }

        const meaningfulChanges = priceChanges.filter(
            (change) => change.previousUnitPrice !== change.newUnitPrice,
        );

        if (meaningfulChanges.length === 0) {
            return;
        }

        const currencyCode = order.currencyCode || ctx.currencyCode || 'USD';
        const noteLines = meaningfulChanges.map((change) => {
            const orderLine = order.lines.find((line) => idsAreEqual(line.id, change.orderLineId));
            const productName = orderLine?.productVariant?.name || `OrderLine ${change.orderLineId}`;
            const formattedPrevious = this.formatAmount(change.previousUnitPrice, currencyCode);
            const formattedNew = this.formatAmount(change.newUnitPrice, currencyCode);
            return `${productName} (OrderLine ${change.orderLineId}) price updated: ${formattedPrevious} -> ${formattedNew}`;
        });

        const note = noteLines.join('\n');

        await this.historyService.createHistoryEntryForOrder({
            ctx,
            orderId,
            type: ORDER_LINE_PRICE_UPDATED,
            data: {
                note,
                currencyCode,
                changes: meaningfulChanges.map((change) => ({
                    orderLineId: change.orderLineId,
                    variantId: change.variantId,
                    previousUnitPrice: change.previousUnitPrice,
                    newUnitPrice: change.newUnitPrice,
                })),
            },
        });
    }

    private formatAmount(amount: number, currencyCode: string): string {
        const majorUnitValue = amount / 100;
        return `${currencyCode} ${majorUnitValue.toFixed(2)}`;
    }

    private async processPriceUpdate(job: any, isHighPriority: boolean) {
        try {
            const { variantIds, variantPrices, channelToken, languageCode } = job.data;
            const chunkSize = isHighPriority ? 50 : 20; // Smaller chunks for low priority
            const priorityChunks = 3; // First 3 chunks are high priority (active users)

            Logger.info(
                `[Job ${job.id}] Processing ${isHighPriority ? 'high' : 'low'} priority price update for ${variantIds.length} variant(s)`,
                'PriceUpdatePlugin'
            );

            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channelToken,
                languageCode: languageCode ?? LanguageCode.en,
            });

            // Orders are sorted by updatedAt DESC (most recent = active users first)
            const activeOrders = await this.findActiveOrdersWithVariants(ctx, variantIds);
            Logger.info(
                `[Job ${job.id}] Found ${activeOrders.length} active orders (sorted by activity, most recent first)`,
                'PriceUpdatePlugin'
            );

            if (activeOrders.length === 0) {
                Logger.info(`[Job ${job.id}] No active orders found, job completed`, 'PriceUpdatePlugin');
                return { updatedOrders: 0, totalOrders: 0 };
            }

            // Process in chunks
            let processedCount = 0;
            const totalChunks = Math.ceil(activeOrders.length / chunkSize);
            const priorityOrderCount = Math.min(priorityChunks * chunkSize, activeOrders.length);
            
            Logger.info(
                `[Job ${job.id}] First ${priorityOrderCount} orders (${priorityChunks} chunks) will be processed with priority (likely active users)`,
                'PriceUpdatePlugin'
            );

            for (let i = 0; i < activeOrders.length; i += chunkSize) {
                const chunk = activeOrders.slice(i, i + chunkSize);
                const currentChunk = Math.floor(i / chunkSize) + 1;
                const isPriorityChunk = currentChunk <= priorityChunks;

                // Process chunk in parallel
                await Promise.all(
                    chunk.map(order => 
                        this.retryOnDeadlock(() => 
                            this.updateOrderPricesOptimized(ctx, order, variantPrices)
                        ).catch((e: any) => {
                            Logger.error(
                                `[Job ${job.id}] Order ${order.code} update failed: ${e?.message}`,
                                'PriceUpdatePlugin',
                                e.stack
                            );
                        })
                    )
                );

                processedCount += chunk.length;
                const progress = Math.floor((processedCount / activeOrders.length) * 100);
                await job.setProgress(progress);

                const chunkLabel = isPriorityChunk ? '⚡ PRIORITY' : 'standard';
                Logger.info(
                    `[Job ${job.id}] Chunk ${currentChunk}/${totalChunks} (${chunkLabel}) completed. Progress: ${progress}%`,
                    'PriceUpdatePlugin'
                );

                // Add delay between chunks
                // No delay for priority chunks (process fast)
                // Add delay for non-priority chunks (reduce server load)
                if (i + chunkSize < activeOrders.length) {
                    const delayMs = isPriorityChunk ? 100 : 1000; // 100ms for priority, 1s for others
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }

            Logger.info(
                `[Job ${job.id}] Completed. Updated ${processedCount}/${activeOrders.length} orders`,
                'PriceUpdatePlugin'
            );

            return {
                updatedOrders: processedCount,
                totalOrders: activeOrders.length,
            };
        } catch (error: any) {
            Logger.error(
                `[Job ${job.id}] Job failed with error: ${error.message}`,
                'PriceUpdatePlugin',
                error.stack
            );
            throw error; // Re-throw to trigger job retry
        }
    }

    private async findActiveOrdersWithVariants(
        ctx: RequestContext,
        variantIds: ID[]
    ): Promise<Order[]> {
        const orders = await this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('order')
            .innerJoin('order.lines', 'line')
            .leftJoinAndSelect('order.channels', 'channel')
            .leftJoinAndSelect('order.lines', 'lines')
            .leftJoinAndSelect('lines.productVariant', 'variant')
            .where('order.active = :active', { active: true })
            .andWhere('line.productVariantId IN (:...variantIds)', { variantIds })
            .orderBy('order.updatedAt', 'DESC') // Most recently updated first = active users
            .getMany();
        
        Logger.info(
            `Found ${orders.length} orders, sorted by activity (most recent first)`,
            'PriceUpdatePlugin'
        );
        
        return orders;
    }

    private async retryOnDeadlock<T>(fn: () => Promise<T>, retries: number = 3, delayMs: number = 200): Promise<T> {
        let attempt = 0;
        let lastError: any;
        while (attempt <= retries) {
            try {
                return await fn();
            } catch (e: any) {
                const msg = e?.message || '';
                if (msg.includes('Deadlock') && attempt < retries) {
                    await new Promise(res => setTimeout(res, delayMs));
                    delayMs = Math.min(delayMs * 2, 2000);
                    attempt++;
                    continue;
                }
                lastError = e;
                break;
            }
        }
        throw lastError;
    }
}

@Resolver()
export class PriceSyncAdminResolver {
    constructor(private priceUpdateService: PriceUpdateService) {}

    @Query()
    @Allow(Permission.SuperAdmin)
    priceSyncBatches(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: { skip?: number; take?: number } },
    ): Promise<{ items: PriceSyncBatch[]; totalItems: number; pendingInQueue: number }> {
        return this.priceUpdateService.getSyncBatches(ctx, args.options ?? {});
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [PriceSyncQueueItem, PriceSyncBatch],
    providers: [PriceUpdateService, PriceSyncHealthService],
    exports: [PriceUpdateService], // Export so it's available in resolvers
    shopApiExtensions: {
        schema: priceUpdateHistorySchema,
        resolvers: [PriceUpdateOrderEntityResolver],
    },
    adminApiExtensions: {
        schema: priceUpdateAdminSchema,
        resolvers: [PriceUpdateOrderEntityResolver, PriceSyncAdminResolver],
    },
    compatibility: '^3.6.3',
    configuration: (config) => {
        // Add OrderInterceptor for lazy price updates
        // This intercepts order reads and updates prices automatically
        config.orderOptions.orderInterceptors = config.orderOptions.orderInterceptors || [];
        config.orderOptions.orderInterceptors.push(new PriceUpdateInterceptor());
        // Health-gated background drain of the durable price-sync backlog.
        config.schedulerOptions.tasks = [
            ...(config.schedulerOptions.tasks ?? []),
            priceSyncDrainTask,
        ];
        return config;
    },
})
export class PriceUpdatePlugin {
    static uiExtensions: AdminUiExtension = {
        extensionPath: path.join(__dirname, 'ui'),
        ngModules: [
            {
                type: 'shared' as const,
                ngModuleFileName: 'price-update-ui-extension.module.ts',
                ngModuleName: 'PriceUpdateUiExtensionModule',
            },
        ],
    };
}
