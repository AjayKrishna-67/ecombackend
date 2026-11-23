import { Injectable } from '@nestjs/common';
import {
    TransactionalConnection,
    OrderService,
    RequestContextService,
    Order,
    Logger,
    Channel,
    CacheService,
} from '@vendure/core';
import { RazorpaySettlementService } from './razorpay-settlement.service';

@Injectable()
export class RazorpayReconciliationService {
    private processedOrderIds = new Set<string>();

    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private requestContextService: RequestContextService,
        private cacheService: CacheService,
        private settlementService: RazorpaySettlementService,
    ) {}

    async reconcilePendingOrders() {
        // Reset processed orders at the start of each reconciliation run
        this.processedOrderIds.clear();

        const channels = await this.connection.getRepository(Channel).find({
            relations: ['defaultTaxZone']
        });

        // Filter out default channel - orders should be processed in their sub-channel context
        // This prevents orders from being processed with wrong channel context
        const nonDefaultChannels = channels.filter(c => c.code !== '__default_channel__');

        Logger.info(`[Reconciliation] Job started. Checking ${nonDefaultChannels.length} channels (excluding default)...`, 'RazorpayPlugin');

        // Process only sub-channels - orders in default channel will be handled
        // when they're found in their respective sub-channel
        for (const channel of nonDefaultChannels) {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channel,
            });

            await this.reconcileForChannel(ctx);

            // Also check AddingItems orders that have a razorpayOrderId (payment might have been collected)
            await this.reconcileAddingItemsOrders(ctx);
        }

        Logger.info(`[Reconciliation] Job completed. Processed ${this.processedOrderIds.size} unique orders across ${nonDefaultChannels.length} channels.`, 'RazorpayPlugin');
    }

    private async reconcileForChannel(ctx: any) {
        // [1] CLIENT: build a CHANNEL-SCOPED Razorpay client. The old query here
        // was `findOne({ where: { handler: { code } } })` with no channel filter,
        // so with multiple channels it returned an arbitrary PaymentMethod row —
        // often one without this channel's keys — leaving razorpayClient null and
        // silently blocking every revert (see "no client to verify" logs).
        // getRazorpayClientForCtx scopes by ch.id = channelId, the same as the
        // shop resolver, so the client resolves for the order's real channel.
        const razorpayClient = await this.settlementService.getRazorpayClientForCtx(ctx);
        if (!razorpayClient) {
            Logger.warn(`[Reconciliation] No Razorpay client for channel ${ctx.channel?.code ?? ctx.channelId}; reverts will be skipped for this channel.`, 'RazorpayPlugin');
        }

        // [2] Batch Processing Loop
        const BATCH_SIZE = 50;
        let offset = 0;
        let totalProcessed = 0;
        const MAX_ORDERS = 1000; // Safety limit

        while (offset < MAX_ORDERS) {
            const pendingOrders = await this.connection.getRepository(ctx, Order).find({
                where: {
                    state: 'ArrangingPayment',
                    channels: { id: ctx.channelId }
                } as any,
                relations: ['payments', 'customer', 'channels','lines'],
                order: { updatedAt: 'DESC' },
                skip: offset,
                take: BATCH_SIZE
            });

            if (pendingOrders.length === 0) {
                break; // No more orders to process
            }

            let processedInBatch = 0;

            for (const order of pendingOrders) {
                // Skip if this order was already processed in this reconciliation run
                const orderIdStr = String(order.id);
                if (this.processedOrderIds.has(orderIdStr)) {
                    continue; // Already processed, don't log to reduce spam
                }

                // Mark as processed to prevent duplicate processing
                this.processedOrderIds.add(orderIdStr);

                // [3] CACHE: Check Cooldown
                const cooldownKey = `razorpay-cooldown:${order.code}`;
                const inCooldown = await this.cacheService.get(cooldownKey);

                if (inCooldown) {
                    continue;
                }

                await this.processSingleOrder(ctx, order, razorpayClient);
                processedInBatch++;
            }

            totalProcessed += processedInBatch;
            offset += BATCH_SIZE;

            // If we didn't process any new orders in this batch, stop
            if (processedInBatch === 0) {
                Logger.info(`[Reconciliation] No new orders to process in this batch. Stopping.`, 'RazorpayPlugin');
                break;
            }
        }
    }

    private async processSingleOrder(ctx: any, order: Order, razorpayClient: any) {
        let isOrderSettled = false;
        let errorOccurred = false;

        // (A former "JOB A" placed orders whose recorded payment looked big enough,
        // using a `payAmount * 100` rupee/paise fudge. transitionToState RETURNS an
        // error instead of throwing, so its try/catch logged "SUCCESS" for orders it
        // could not place and then skipped the settle + alert below. Removed: the
        // locked settlement path handles an already-recorded Razorpay payment itself.)

        // --- JOB B: SETTLE VIA THE SINGLE SOURCE OF TRUTH ---
        if ((order.customFields as any).razorpayOrderId && razorpayClient) {
            const result = await this.settlementService.settleFromRazorpay(ctx, order, razorpayClient, 'Reconciliation');
            if (result.status === 'settled' || result.status === 'authorized' || result.status === 'already') {
                isOrderSettled = true;
            } else if (result.status === 'error') {
                // Could not verify with Razorpay — cooldown + skip revert (never revert on uncertainty).
                Logger.warn(`[Reconciliation] Settlement could not verify ${order.code}; applying cooldown.`, 'RazorpayPlugin');
                errorOccurred = true;
            }
        }

        // --- JOB C: REVERT STALE ORDERS ---
        Logger.info(`[Reconciliation] Order ${order.code} - isOrderSettled: ${isOrderSettled}, errorOccurred: ${errorOccurred}, hasRazorpayOrderId: ${!!(order.customFields as any).razorpayOrderId}, hasRazorpayClient: ${!!razorpayClient}`, 'RazorpayPlugin');
        if (!isOrderSettled && !errorOccurred) {
            await this.checkAndRevertStaleOrder(ctx, order, razorpayClient);
        } else if (errorOccurred) {
            Logger.info(`[Reconciliation] Skipping revert for ${order.code} due to API error (10 min cooldown applied)`, 'RazorpayPlugin');
        }

        // [4] CACHE: Set Cooldown on Error
        if (errorOccurred) {
            const cooldownKey = `razorpay-cooldown:${order.code}`;
            // Manually set true for 10 minutes
            await this.cacheService.set(cooldownKey, true, { ttl: 600000 });
        }
    }

    private async checkAndRevertStaleOrder(ctx: any, order: Order, razorpayClient?: any) {
        const razorpayOrderId = (order.customFields as any).razorpayOrderId;

        // Money already recorded on the order (e.g. an underpaid app payment that
        // cannot cover the total) means it must never go back to a cart: a human
        // decides. The settlement path above has already tried to place it.
        const recordedPayment = order.payments?.find(p => p.state === 'Settled' || p.state === 'Authorized');
        if (recordedPayment) {
            Logger.warn(`[Reconciliation] REFUSING to revert ${order.code}: it already has a ${recordedPayment.state} payment of ${recordedPayment.amount} (total ${order.totalWithTax}).`, 'RazorpayPlugin');
            await this.settlementService.emitMoneyStuckAlert(order, razorpayOrderId ?? 'none', order.state);
            return;
        }

        // AGE GATE: never yank an order the user may still be paying for. This cron
        // is the backstop for app-killed sessions where no webhook/mutation fires.
        // CLOCK: use the Razorpay order's created_at, NOT order.updatedAt. updatedAt
        // is bumped by any cart/shipping/activeOrder query, so a user idling in the
        // app after abandoning payment kept resetting it — the gate never elapsed and
        // the order never reverted. created_at is fixed once the payment window opens.
        // Threshold matches the ~5-min Razorpay hosted-page timeout; money safety is
        // still enforced separately by getPaymentActivity below.
        const ARRANGING_THRESHOLD_SECONDS = 300; // 5 minutes (hosted-page timeout)
        let ageSeconds: number;
        if (razorpayOrderId && razorpayClient) {
            const createdAtMs = await this.settlementService.getRazorpayOrderCreatedAtMs(razorpayOrderId, razorpayClient);
            ageSeconds = createdAtMs
                ? Math.floor((Date.now() - createdAtMs) / 1000)
                : Math.floor((Date.now() - new Date(order.updatedAt).getTime()) / 1000); // fallback
        } else {
            ageSeconds = Math.floor((Date.now() - new Date(order.updatedAt).getTime()) / 1000);
        }
        if (ageSeconds >= 0 && ageSeconds < ARRANGING_THRESHOLD_SECONDS) {
            Logger.info(`[Reconciliation] ${order.code} payment window only ${ageSeconds}s old; user may be paying. Skip revert.`, 'RazorpayPlugin');
            return;
        }

        // AUTHORITATIVE, and now the ONLY gate. `isPaymentWindowOpen` is demoted to a
        // UI hint — it never governs this destructive revert. If the order has a
        // Razorpay order we must confirm it is genuinely unpaid before reverting:
        // 'unpaid' reverts, 'in-progress' (customer still approving) waits for the
        // next run, 'paid' / 'unknown' refuse. Without a client we cannot verify, so
        // we refuse to revert.
        if (razorpayOrderId) {
            if (!razorpayClient) {
                Logger.warn(`[Reconciliation] ${order.code} has a Razorpay order but no client to verify; skipping revert.`, 'RazorpayPlugin');
                return;
            }
            const activity = await this.settlementService.getPaymentActivity(razorpayOrderId, razorpayClient);
            if (activity === 'in-progress') {
                Logger.info(`[Reconciliation] ${order.code} has a Razorpay attempt still awaiting the customer's bank/UPI approval. Skip revert.`, 'RazorpayPlugin');
                return;
            }
            if (activity !== 'unpaid') {
                Logger.warn(`[Reconciliation] REFUSING to revert ${order.code}: Razorpay reports paid/captured or status could not be verified. Leaving in ArrangingPayment.`, 'RazorpayPlugin');
                // If we reach here, JOB B already tried to settle and did not succeed,
                // yet Razorpay still holds money for this order. That is a money-stuck
                // order that needs a human. Emit a distinct, greppable ERROR marker so
                // the existing log pipeline (Prometheus/Loki/Grafana) can alert on it.
                await this.settlementService.emitMoneyStuckAlert(order, razorpayOrderId, order.state);
                return;
            }
        }

        // Razorpay authoritatively confirms no payment (or there is no Razorpay order
        // at all) — safe to revert the stale ArrangingPayment order to AddingItems.
        try {
            const revert = await this.orderService.transitionToState(ctx, order.id, 'AddingItems');
            if ((revert as any)?.errorCode) {
                Logger.warn(`[Reconciliation] Could not revert ${order.code} to AddingItems: ${(revert as any).message}`, 'RazorpayPlugin');
                return;
            }
            if ((order.customFields as any).isPaymentWindowOpen) {
                await this.orderService.updateCustomFields(ctx, order.id, { isPaymentWindowOpen: false });
            }
            Logger.info(`[Reconciliation] SUCCESS: Reverted Order ${order.code} to AddingItems (Razorpay confirms unpaid).`, 'RazorpayPlugin');
        } catch (e: any) {
            Logger.error(`[Reconciliation] Error reverting ${order.code} to AddingItems: ${e.message}`, 'RazorpayPlugin');
        }
    }

    /**
     * Reconcile orders that are in AddingItems state but have a razorpayOrderId.
     * This handles cases where payment was collected but order was reverted to AddingItems.
     */
    private async reconcileAddingItemsOrders(ctx: any) {
        // CHANNEL-SCOPED client (same fix as reconcileForChannel) — the old
        // non-scoped PaymentMethod query could resolve the wrong channel's keys.
        const razorpayClient = await this.settlementService.getRazorpayClientForCtx(ctx);
        if (!razorpayClient) {
            return; // No client for this channel, skip
        }

        // Find orders in AddingItems state that have a razorpayOrderId
        // These are orders that were reverted but might have payment collected
        const addingItemsOrders = await this.connection.getRepository(ctx, Order).find({
            where: {
                state: 'AddingItems',
                channels: { id: ctx.channelId }
            } as any,
            relations: ['payments', 'channels'],
            order: { updatedAt: 'DESC' },
            take: 50 // Limit to prevent overload
        });

        // Filter to only orders with razorpayOrderId
        const ordersWithRazorpayId = addingItemsOrders.filter(order =>
            (order.customFields as any).razorpayOrderId
        );

        if (ordersWithRazorpayId.length === 0) {
            return;
        }

        Logger.info(`[Reconciliation] Found ${ordersWithRazorpayId.length} AddingItems orders with Razorpay ID to check`, 'RazorpayPlugin');

        for (const order of ordersWithRazorpayId) {
            const orderIdStr = String(order.id);
            if (this.processedOrderIds.has(orderIdStr)) {
                continue;
            }
            this.processedOrderIds.add(orderIdStr);

            // Check cooldown
            const cooldownKey = `razorpay-cooldown:${order.code}`;
            const inCooldown = await this.cacheService.get(cooldownKey);
            if (inCooldown) {
                continue;
            }

            // Only process AddingItems orders after 3 minutes have passed
            // This gives users time to complete their payment before we check Razorpay API
            const ADDING_ITEMS_THRESHOLD_SECONDS = 180; // 3 minutes
            const timeDiff = Date.now() - new Date(order.updatedAt).getTime();
            const secondsSinceUpdate = Math.floor(timeDiff / 1000);

            // Handle timezone mismatch - skip if time appears negative
            if (secondsSinceUpdate < 0) {
                Logger.warn(`[Reconciliation] Timezone mismatch for AddingItems order ${order.code}: updatedAt is ${Math.abs(secondsSinceUpdate)}s in the future. Skipping.`, 'RazorpayPlugin');
                continue;
            }

            if (secondsSinceUpdate < ADDING_ITEMS_THRESHOLD_SECONDS) {
                Logger.info(`[Reconciliation] AddingItems order ${order.code} not old enough (${secondsSinceUpdate}s < ${ADDING_ITEMS_THRESHOLD_SECONDS}s). Skipping Razorpay check.`, 'RazorpayPlugin');
                continue;
            }

            // UPPER age bound: a razorpayOrderId this old cannot still be collecting
            // money — no live checkout stays open for a day. Probing it just burns a
            // Razorpay API call every cooldown cycle (and yields 401s for orders whose
            // ids were minted under old/test keys). Skip; a stale AddingItems cart is
            // harmless (customer simply re-checks-out).
            const ADDING_ITEMS_MAX_AGE_SECONDS = 24 * 60 * 60; // 1 day
            if (secondsSinceUpdate > ADDING_ITEMS_MAX_AGE_SECONDS) {
                continue;
            }

            // AddingItems + rzpOrderId = payment may have been collected then reverted.
            // The single settlement path handles AddingItems -> ArrangingPayment ->
            // Settled/Authorized atomically and idempotently.
            const result = await this.settlementService.settleFromRazorpay(ctx, order, razorpayClient, 'Reconciliation (AddingItems)');
            // `incomplete` = money captured but cart can't advance (settleFromRazorpay has
            // already emitted MONEY-STUCK-ALERT); `error` = transient. Either way, cool this
            // order down so we don't re-hit Razorpay every cycle for a case that won't
            // self-heal without either cart completion or manual intervention.
            if (result.status === 'error' || result.status === 'incomplete') {
                await this.cacheService.set(cooldownKey, true, { ttl: 600000 });
            }
        }
    }
    // Money-stuck alerting now lives in RazorpaySettlementService.emitMoneyStuckAlert,
    // fired from the single settlement path so webhook + reconciliation + self-heal all
    // alert consistently. (Previously a copy here was never wired to a caller.)

}