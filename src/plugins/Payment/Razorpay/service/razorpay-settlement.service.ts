import { Injectable } from '@nestjs/common';
import {
    TransactionalConnection, OrderService, RequestContextService, HistoryService,
    PaymentMethod, Order, Payment, Logger, RequestContext, CacheService, ID,
} from '@vendure/core';
import { HistoryEntryType } from '@vendure/common/lib/generated-types';
import { LockNotSupportedOnGivenDriverError } from 'typeorm';
import { getRazorpayConfig, RazorpayConfig } from '../utils/config-helper';
import { getRazorpayInstance } from '../utils/razorpay-utils';
import { decidePriceLockRepair, PriceLockRepairDecision, PriceLockStuckReason } from '../utils/decide-price-lock-repair';
import { razorpayPaymentHandler } from '../handler/razorpay.handler';
import { RAZORPAY_WEBHOOK_TYPE, RazorpayPaymentActivity } from '../types';

/** Thrown inside the settlement transaction when the price lock refuses to settle (rolls it back). */
class PriceLockStuckError extends Error {
    constructor(
        readonly reason: PriceLockStuckReason | 'repair-mismatch',
        readonly capturedAmount: number,
        readonly totalWithTax: number,
        readonly quotedAmount: number | null,
    ) {
        super(`price lock: ${reason} (captured ${capturedAmount}, total ${totalWithTax}, quoted ${quotedAmount ?? 'unknown'})`);
    }
}

const rupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/**
 * How long a Razorpay attempt still in `created` (customer approving in the UPI
 * app / on the bank page) blocks a revert. Above Razorpay's 12-minute minimum
 * auto-capture window, so a normal approval always lands inside it.
 */
const PENDING_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Outcome of a settlement attempt.
 * - `settled` / `authorized`      → money applied, order advanced.
 * - `already`                     → order was already Settled/Authorized (idempotent no-op).
 * - `no-capture`                  → Razorpay holds NO money for this order (nothing to do).
 * - `terminal`                    → Razorpay HAS money but the order is already placed
 *                                   (Delivered/Shipped/Cancelled/…). Benign here; a NEW
 *                                   capture on a placed order may be a duplicate to review.
 * - `incomplete`                  → Razorpay HAS captured money but the order is stuck in a
 *                                   pre-payment state that cannot advance (e.g. AddingItems
 *                                   cart with no shipping method). THIS IS STUCK MONEY — an
 *                                   alert is emitted. Retrying may self-heal if the cart is
 *                                   completed, so callers should surface it, not swallow it.
 * - `error`                       → transient failure (Razorpay API / DB). Caller should retry.
 *   `error` means "could not verify" — callers must NOT revert.
 */
export type SettlementStatus =
    'settled' | 'authorized' | 'already' | 'no-capture' | 'terminal' | 'incomplete' | 'not-found' | 'error';

export interface SettlementResult {
    status: SettlementStatus;
    orderCode?: string;
    paymentId?: string;
}

/**
 * THE single source of truth for turning a paid Razorpay order into a settled
 * Vendure order. Every path (webhook worker, reconciliation cron, admin
 * self-heal) calls this — there is exactly one place that creates the Payment
 * row and drives the AddingItems -> ArrangingPayment -> PaymentSettled/Authorized
 * transition.
 *
 * Invariants:
 * - Razorpay is authoritative. We fetch payments live and act on `captured` /
 *   `authorized`, never on a local flag.
 * - Idempotent. Re-running on an already-settled order is a no-op. Safe under
 *   at-least-once, out-of-order webhook delivery.
 * - Atomic. Payment insert + state transition happen in one transaction; a
 *   failed transition rolls back the insert (no orphan Settled payment).
 */
@Injectable()
export class RazorpaySettlementService {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private requestContextService: RequestContextService,
        private historyService: HistoryService,
        private cacheService: CacheService,
    ) {}

    /**
     * Resolve the order + its channel context + a Razorpay client from a
     * Razorpay order id, then settle. Used by the webhook worker and any caller
     * that only has the Razorpay id.
     */
    async settleByRazorpayOrderId(rzpOrderId: string, source: string): Promise<SettlementResult> {
        const adminCtx = await this.requestContextService.create({ apiType: 'admin' });
        const lookup = await this.connection.getRepository(adminCtx, Order).findOne({
            where: { customFields: { razorpayOrderId: rzpOrderId } as any },
            relations: ['channels'],
        });
        if (!lookup) {
            Logger.warn(`[Settlement] No order found for Razorpay order ${rzpOrderId}`, 'RazorpayPlugin');
            return { status: 'not-found' };
        }
        const ctx = await this.resolveChannelContext(lookup);
        const client = await this.getRazorpayClientForCtx(ctx);
        if (!client) {
            Logger.warn(`[Settlement] No Razorpay client for order ${lookup.code}'s channel`, 'RazorpayPlugin');
            return { status: 'error' };
        }
        const order = await this.connection.getRepository(ctx, Order).findOne({
            where: { id: lookup.id },
            relations: ['payments', 'channels'],
        });
        if (!order) return { status: 'not-found' };
        return this.settleFromRazorpay(ctx, order, client, source);
    }

    /**
     * CORE. Given a channel context, the order, and a Razorpay client, mirror
     * Razorpay's payment state into Vendure. Idempotent + atomic.
     */
    async settleFromRazorpay(
        ctx: RequestContext, order: Order, rzpClient: any, source: string,
    ): Promise<SettlementResult> {
        if (order.state === 'PaymentSettled' || order.state === 'PaymentAuthorized') {
            return { status: 'already', orderCode: order.code };
        }
        const rzpOrderId = (order.customFields as any).razorpayOrderId;
        if (!rzpOrderId) return { status: 'no-capture', orderCode: order.code };

        let payments: any;
        try {
            payments = await rzpClient.orders.fetchPayments(rzpOrderId);
        } catch (e: any) {
            // The Razorpay SDK rejects with an API-error object, NOT a JS Error, so
            // e.message is undefined. The real reason lives in e.statusCode / e.error.description.
            const reason = e?.error?.description || e?.message || JSON.stringify(e);
            const statusCode = e?.statusCode ?? 'n/a';
            Logger.warn(`[Settlement] Could not fetch Razorpay payments for ${order.code} (${rzpOrderId}): [${statusCode}] ${reason}`, 'RazorpayPlugin');
            return { status: 'error', orderCode: order.code };
        }

        const captured = payments?.items?.find((p: any) => p.status === 'captured');
        const authorized = payments?.items?.find((p: any) => p.status === 'authorized');
        const target = captured
            ? { rzp: captured, paymentState: 'Settled' as const, orderState: 'PaymentSettled' as const, result: 'settled' as const }
            : authorized
                ? { rzp: authorized, paymentState: 'Authorized' as const, orderState: 'PaymentAuthorized' as const, result: 'authorized' as const }
                : null;

        if (!target) {
            return { status: 'no-capture', orderCode: order.code };
        }

        Logger.info(`[Settlement] ${order.code}: Razorpay ${target.result} payment ${target.rzp.id} found via ${source}. Settling...`, 'RazorpayPlugin');

        // Price lock: the quote (Razorpay order amount + creation time) is only needed
        // when the amounts differ. Fetched here, never while holding the row lock.
        const capturedAmount = Number(target.rzp.amount);
        const quote = capturedAmount === order.totalWithTax
            ? { amount: null, createdAtMs: null }
            : await this.fetchRazorpayOrderFacts(rzpOrderId, rzpClient);
        let decision: PriceLockRepairDecision = { action: 'ok' };
        // Razorpay sends payment.authorized and payment.captured together, so two
        // jobs often settle the same order at once. The loser must not report or
        // record a second settlement (it wrote a duplicate history entry before).
        let settledByOtherPath = false;

        try {
            await this.connection.withTransaction(ctx, async txCtx => {
                // Take the order's row lock BEFORE reading its state. Without this
                // the guard below was decorative: MySQL's REPEATABLE READ gives
                // each transaction a snapshot taken at its own start, so three
                // copies of the same Razorpay Settlement webhook all read
                // `AddingItems`, all concluded nobody had won, and all settled.
                // Each extra ArrangingPayment -> PaymentSettled transition makes
                // Vendure allocate the order's stock AGAIN (see
                // DefaultStockAllocationStrategy) while the single later
                // fulfillment releases it only once — which is how 31% of orders
                // permanently over-reserved their stock.
                //
                // Lock query kept separate from the read below: TypeORM refuses a
                // pessimistic lock on a query that joins relations, and `payments`
                // is needed here. FOR UPDATE on the row alone is what serialises.
                await this.lockOrderRow(txCtx, order.id);
                const o = await this.connection.getRepository(txCtx, Order).findOne({
                    where: { id: order.id } as any,
                    relations: ['payments'],
                });
                if (!o) throw new Error('Order vanished during settlement');
                // Now meaningful: the loser of the race blocks on the lock above
                // until the winner commits, then reads the state the winner wrote.
                if (o.state === 'PaymentSettled' || o.state === 'PaymentAuthorized') {
                    settledByOtherPath = true;
                    return; // idempotent: another path won the race
                }
                if (o.state === 'AddingItems') {
                    const ns = await this.orderService.getNextOrderStates(o);
                    if (!ns.includes('ArrangingPayment')) {
                        throw new Error(`Cannot transition ${o.code} from AddingItems. Available: ${ns.join(', ')}`);
                    }
                    const r = await this.orderService.transitionToState(txCtx, o.id, 'ArrangingPayment');
                    if ((r as any)?.errorCode) throw new Error((r as any).message);
                    o.state = 'ArrangingPayment';
                }
                if (o.state !== 'ArrangingPayment') {
                    throw new Error(`Order ${o.code} is in ${o.state}, cannot settle`);
                }
                // Price lock safety net: compare what was captured with what is still
                // owed (total minus OTHER recorded payments), and honor the quote,
                // record an overpay, or stop for staff (decidePriceLockRepair).
                const otherPaid = (o.payments ?? [])
                    .filter(p => p.transactionId !== target.rzp.id && (p.state === 'Settled' || p.state === 'Authorized'))
                    .reduce((sum, p) => sum + p.amount, 0);
                decision = decidePriceLockRepair({
                    capturedAmount,
                    razorpayOrderAmount: quote.amount,
                    totalWithTax: o.totalWithTax - otherPaid,
                    capturedAtMs: target.rzp.created_at ? Number(target.rzp.created_at) * 1000 : null,
                    nowMs: Date.now(),
                    stayedInArrangingPayment: await this.hasStayedInArrangingPayment(txCtx, o.id, quote.createdAtMs),
                });
                if (decision.action === 'stuck') {
                    throw new PriceLockStuckError(decision.reason, capturedAmount, o.totalWithTax, quote.amount);
                }
                if (decision.action === 'repair') {
                    await this.applyQuoteAdjustment(txCtx, o.id, decision.adjustment, capturedAmount + otherPaid);
                }
                const exists = o.payments?.find(p => p.transactionId === target.rzp.id);
                if (!exists) {
                    // Raw insert with only the FK reference avoids TypeORM cascade
                    // re-writing the order's channel associations.
                    await this.connection.getRepository(txCtx, Payment)
                        .createQueryBuilder()
                        .insert()
                        .into(Payment)
                        .values({
                            method: razorpayPaymentHandler.code,
                            amount: parseInt(target.rzp.amount.toString()),
                            state: target.paymentState,
                            transactionId: target.rzp.id,
                            metadata: {
                                mode: 'Online',
                                source,
                                razorpayPaymentId: target.rzp.id,
                                razorpayOrderId: rzpOrderId,
                            },
                            order: { id: o.id },
                        } as any)
                        .execute();
                }
                const ns2 = await this.orderService.getNextOrderStates(o);
                if (!ns2.includes(target.orderState)) {
                    throw new Error(`${target.orderState} not reachable for ${o.code}. Available: ${ns2.join(', ')}`);
                }
                const r2 = await this.orderService.transitionToState(txCtx, o.id, target.orderState);
                if ((r2 as any)?.errorCode) throw new Error((r2 as any).message);
                await this.orderService.updateCustomFields(txCtx, o.id, {
                    razorpayPaymentId: target.rzp.id,
                    isPaymentWindowOpen: false,
                });
            });
        } catch (e: any) {
            Logger.error(`[Settlement] Failed to settle ${order.code} (rolled back): ${e.message}`, 'RazorpayPlugin');
            // A `target` existed, so Razorpay HELD MONEY for this order — the failure is
            // not "nothing to do". Classify by the order's live state so callers can tell
            // a benign duplicate-on-a-placed-order from genuinely stranded money.
            const live = await this.connection.getRepository(ctx, Order).findOne({ where: { id: order.id } as any });
            const state = live?.state ?? order.state;
            if (state !== 'AddingItems' && state !== 'ArrangingPayment') {
                // Order already placed/cancelled — this capture couldn't attach but the
                // order is handled. Likely a duplicate Razorpay order; flag for review.
                Logger.warn(`[Settlement] ${order.code} holds a Razorpay ${target.result} payment ${target.rzp.id} but is already in ${state} — possible duplicate capture, review for refund.`, 'RazorpayPlugin');
                return { status: 'terminal', orderCode: order.code, paymentId: target.rzp.id };
            }
            // Pre-payment state that could not advance (e.g. incomplete cart) → stuck money.
            // A price-lock refusal is deterministic, so it alerts at once with the amounts.
            await this.emitMoneyStuckAlert(order, rzpOrderId, state, e instanceof PriceLockStuckError ? e : undefined);
            return { status: 'incomplete', orderCode: order.code, paymentId: target.rzp.id };
        }
        if (settledByOtherPath) {
            Logger.info(`[Settlement] ${order.code} was already settled by another path; ${source} did nothing`, 'RazorpayPlugin');
            return { status: 'already', orderCode: order.code };
        }
        await this.recordPriceLockOutcome(ctx, order, decision, capturedAmount, target.rzp.id);

        // History entry for admin visibility (best-effort, outside the tx).
        try {
            await this.historyService.createHistoryEntryForOrder({
                ctx, orderId: order.id, type: RAZORPAY_WEBHOOK_TYPE,
                data: {
                    webhookEvent: 'Settlement',
                    source,
                    paymentId: target.rzp.id,
                    razorpayOrderId: rzpOrderId,
                    amount: parseInt(target.rzp.amount.toString()),
                    status: target.paymentState,
                    timestamp: new Date().toISOString(),
                },
            }, false);
        } catch { /* history is non-critical */ }

        order.state = target.orderState;
        Logger.info(`[Settlement] ${order.code} -> ${target.orderState} (${source})`, 'RazorpayPlugin');
        return { status: target.result, orderCode: order.code, paymentId: target.rzp.id };
    }

    /** FOR UPDATE on the order row. SQLite (e2e tests) has no row locks and serializes writes itself. */
    private async lockOrderRow(txCtx: RequestContext, orderId: ID): Promise<void> {
        try {
            await this.connection.getRepository(txCtx, Order)
                .createQueryBuilder('o')
                .setLock('pessimistic_write')
                .where('o.id = :id', { id: orderId })
                .getOne();
        } catch (e) {
            if (!(e instanceof LockNotSupportedOnGivenDriverError)) {
                throw e;
            }
        }
    }

    /**
     * True when the cart was never sent back to AddingItems after the Razorpay
     * order was created, i.e. the customer paid for exactly the cart they were
     * quoted. Core writes every transition as ORDER_STATE_TRANSITION {from, to}.
     * Null when the Razorpay order's creation time is unknown (fail closed).
     */
    private async hasStayedInArrangingPayment(txCtx: RequestContext, orderId: ID, sinceMs: number | null): Promise<boolean | null> {
        if (sinceMs == null) {
            return null;
        }
        // Time compared in code, not in SQL: SQLite stores datetimes as text, so a
        // DB-side "after" filter silently compares strings there.
        const transitions = await this.historyService.getHistoryForOrder(txCtx, orderId, false, {
            filter: { type: { eq: HistoryEntryType.ORDER_STATE_TRANSITION } },
            take: 1000,
        });
        return !transitions.items.some(t =>
            new Date(t.createdAt).getTime() >= sinceMs && t.data?.from === 'ArrangingPayment' && t.data?.to === 'AddingItems');
    }

    /**
     * Honors the Razorpay quote: a "Checkout amount adjustment" surcharge (no tax
     * lines, like the loyalty discount, D13) brings the total down to what was
     * paid. addSurchargeToOrder re-runs the order calculation (promotions,
     * shipping), so the result is re-read and must match exactly, otherwise the
     * whole settlement rolls back and staff are alerted.
     */
    private async applyQuoteAdjustment(txCtx: RequestContext, orderId: ID, adjustment: number, expectedTotal: number): Promise<void> {
        await this.orderService.addSurchargeToOrder(txCtx, orderId, {
            description: 'Checkout amount adjustment',
            sku: 'PRICE-LOCK-ADJ',
            listPrice: adjustment,
            listPriceIncludesTax: true,
        });
        const adjusted = await this.connection.getRepository(txCtx, Order).findOne({ where: { id: orderId } as any });
        if (adjusted?.totalWithTax !== expectedTotal) {
            throw new PriceLockStuckError('repair-mismatch', expectedTotal, adjusted?.totalWithTax ?? -1, null);
        }
    }

    /** Leaves a staff-visible note for a repaired or overpaid order (best-effort, after commit). */
    private async recordPriceLockOutcome(
        ctx: RequestContext, order: Order, decision: PriceLockRepairDecision, capturedAmount: number, paymentId: string,
    ): Promise<void> {
        let note: string;
        if (decision.action === 'repair') {
            Logger.warn(`[PRICE-LOCK-ADJ] order=${order.code} captured=${capturedAmount} adjustment=${decision.adjustment} payment=${paymentId}`, 'RazorpayPlugin');
            note = `Checkout amount adjustment: the customer paid the quoted ${rupees(capturedAmount)} (Razorpay payment ${paymentId}) ` +
                `but the order total had changed during payment. The quote was honored with an adjustment of ${rupees(decision.adjustment)}.`;
        } else if (decision.action === 'overpay') {
            Logger.error(`[PRICE-LOCK-OVERPAY] order=${order.code} captured=${capturedAmount} refund=${decision.refundAmount} payment=${paymentId}`, 'RazorpayPlugin');
            note = `Overpaid: the customer paid ${rupees(capturedAmount)} (Razorpay payment ${paymentId}), ` +
                `${rupees(decision.refundAmount)} more than the order total. Refund ${rupees(decision.refundAmount)} from the Razorpay dashboard.`;
        } else {
            return;
        }
        try {
            await this.historyService.createHistoryEntryForOrder(
                { ctx, orderId: order.id, type: HistoryEntryType.ORDER_NOTE, data: { note } }, false);
        } catch { /* history is non-critical */ }
    }

    /**
     * Authoritative "may this ArrangingPayment order be reverted?" for every revert
     * path (app dismiss, reconciliation, payment.failed). Razorpay is the source of
     * truth, never a client-set flag: its docs say the checkout callbacks can be
     * missed and status must come from webhooks or the fetch API.
     *
     * A payment still in `created` means the customer submitted details and the
     * bank/UPI app has not answered yet; reverting then would yank the cart while
     * they approve in GPay. Such an attempt only blocks a revert for
     * PENDING_ATTEMPT_WINDOW_MS, after which it is treated as abandoned (a late
     * authorization still settles through the webhook / AddingItems reconciliation).
     */
    async getPaymentActivity(rzpOrderId: string, rzpClient: any): Promise<RazorpayPaymentActivity> {
        try {
            const rzpOrder = await rzpClient.orders.fetch(rzpOrderId);
            if (rzpOrder?.status === 'paid') return 'paid';
            const payments = await rzpClient.orders.fetchPayments(rzpOrderId);
            const items: any[] = payments?.items ?? [];
            if (items.some(p => p.status === 'captured' || p.status === 'authorized')) return 'paid';
            const pendingSince = Date.now() - PENDING_ATTEMPT_WINDOW_MS;
            const isAttemptPending = items.some(p => p.status === 'created' && Number(p.created_at) * 1000 > pendingSince);
            return isAttemptPending ? 'in-progress' : 'unpaid';
        } catch (e: any) {
            const reason = e?.error?.description || e?.message || JSON.stringify(e);
            const statusCode = e?.statusCode ?? 'n/a';
            Logger.warn(`[Settlement] Could not verify Razorpay status for ${rzpOrderId}: [${statusCode}] ${reason}. Treating as unknown (no revert).`, 'RazorpayPlugin');
            return 'unknown';
        }
    }

    /**
     * When the Razorpay order was created (ms epoch), i.e. when the payment window
     * truly opened. This is the STABLE clock for the reconciliation revert gate —
     * unlike Vendure's order.updatedAt, which any cart/shipping query bumps, this
     * never moves once the payment order exists. Returns null on any fetch failure
     * so the caller can fall back to updatedAt.
     */
    async getRazorpayOrderCreatedAtMs(rzpOrderId: string, rzpClient: any): Promise<number | null> {
        return (await this.fetchRazorpayOrderFacts(rzpOrderId, rzpClient)).createdAtMs;
    }

    /**
     * The Razorpay order's quoted amount (what the customer was asked to pay) and
     * creation time, in one fetch. Nulls on any failure, so callers fail closed.
     */
    async fetchRazorpayOrderFacts(rzpOrderId: string, rzpClient: any): Promise<{ amount: number | null; createdAtMs: number | null }> {
        try {
            const rzpOrder = await rzpClient.orders.fetch(rzpOrderId);
            return {
                amount: rzpOrder?.amount != null ? Number(rzpOrder.amount) : null,
                createdAtMs: rzpOrder?.created_at ? rzpOrder.created_at * 1000 : null,
            };
        } catch (e: any) {
            const reason = e?.error?.description || e?.message || JSON.stringify(e);
            Logger.warn(`[Settlement] Could not fetch Razorpay order ${rzpOrderId}: ${reason}`, 'RazorpayPlugin');
            return { amount: null, createdAtMs: null };
        }
    }

    /**
     * Loud, greppable alert for an order where Razorpay holds captured/authorized money
     * but Vendure could not settle it (stuck in a pre-payment state). Age-gated (10 min,
     * so transient blips that self-heal on retry stay quiet) and rate-limited (1/hr/order,
     * so reconciliation + webhook retries don't spam). A Loki/Grafana rule on
     * "[MONEY-STUCK-ALERT]" pages ops; a WhatsApp/MSG91 push can hook in here later.
     */
    async emitMoneyStuckAlert(order: Order, rzpOrderId: string, state: string, priceLock?: PriceLockStuckError): Promise<void> {
        // The age gate lets transient blips self-heal quietly; a price-lock refusal is
        // deterministic (retries cannot change the amounts), so it alerts at once.
        const stuckMs = Date.now() - new Date(order.updatedAt).getTime();
        const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
        if (!priceLock && stuckMs < STUCK_THRESHOLD_MS) return;
        const alertKey = `razorpay-money-stuck-alerted:${order.code}`;
        if (await this.cacheService.get(alertKey)) return;
        const why = priceLock
            ? `amount mismatch (${priceLock.reason}): paid ${priceLock.capturedAmount}, order total ${priceLock.totalWithTax}, quoted ${priceLock.quotedAmount ?? 'unknown'}`
            : 'incomplete cart?';
        Logger.error(`[MONEY-STUCK-ALERT] Order ${order.code} (rzp ${rzpOrderId}) is PAID at Razorpay but cannot settle — stuck in ${state} (${why}). Manual review needed.`, 'RazorpayPlugin');
        await this.cacheService.set(alertKey, true, { ttl: 60 * 60 * 1000 });
    }

    async resolveChannelContext(order: Order): Promise<RequestContext> {
        const channels = (order as any).channels || [];
        const orderChannel = channels.find((c: any) => c.code !== '__default_channel__') || channels[0];
        if (orderChannel?.token) {
            return this.requestContextService.create({ apiType: 'admin', channelOrToken: orderChannel.token });
        }
        return this.requestContextService.create({ apiType: 'admin' });
    }

    async getRazorpayClientForCtx(ctx: RequestContext): Promise<any | null> {
        const config = await this.getRazorpayConfigForCtx(ctx);
        return config ? getRazorpayInstance({ key_id: config.key_id, key_secret: config.key_secret }) : null;
    }

    /** The channel's Razorpay keys, or null when the channel has no usable razorpay-payment method. */
    async getRazorpayConfigForCtx(ctx: RequestContext): Promise<RazorpayConfig | null> {
        const method = await this.connection.getRepository(ctx, PaymentMethod)
            .createQueryBuilder('pm')
            .leftJoin('pm.channels', 'ch')
            .where('pm.code = :code', { code: 'razorpay-payment' })
            .andWhere('ch.id = :channelId', { channelId: ctx.channelId })
            .getOne();
        if (!method) return null;
        const config = getRazorpayConfig(method);
        return config?.key_id && config?.key_secret ? config : null;
    }
}
