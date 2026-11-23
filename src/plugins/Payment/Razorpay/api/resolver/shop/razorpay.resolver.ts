// src/plugins/Payment/Razorpay/api/resolver/shop/razorpay.resolver.ts

import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    RequestContext,
    OrderService,
    TransactionalConnection,
    PaymentMethod,
    Ctx,
    Logger,
    Order,
    ForbiddenError,
    idsAreEqual,
} from '@vendure/core';
import { getRazorpayInstance } from '../../../utils/razorpay-utils';
import { getRazorpayConfig } from '../../../utils/config-helper';
import { RazorpaySettlementService } from '../../../service/razorpay-settlement.service';

@Resolver()
export class RazorpayResolver {
    constructor(
        private orderService: OrderService,
        private connection: TransactionalConnection,
        private settlementService: RazorpaySettlementService,
    ) {}

    @Mutation()
    async generateRazorpayOrderId(
        @Ctx() ctx: RequestContext,
        @Args('orderId') orderId: string
    ) {
        // 1. Fetch the Order with relations
        const order = await this.orderService.findOne(ctx, orderId);
        if (!order) return { success: false, errorMessage: 'Order not found' };

        // 2. Security Check (also blocks anonymous callers)
        if (!this.canAccessOrder(ctx, order)) {
             return { success: false, errorMessage: 'Unauthorized access' };
        }

        // 3. STRICT STATE LOCK: Move to ArrangingPayment. The price is decided once,
        // here: reprice the cart, then lock it. From ArrangingPayment on nothing
        // reprices it (price lock), so the Razorpay amount stays equal to the total.
        const wasAlreadyArrangingPayment = order.state === 'ArrangingPayment';
        if (order.state === 'AddingItems') {
            await this.repriceAtPay(ctx, order);
            const transitionResult = await this.orderService.transitionToState(ctx, order.id, 'ArrangingPayment');
            
            // Explicitly check if the transition failed (e.g., missing shipping method/address)
            if (this.isTransitionError(transitionResult)) {
                Logger.warn(`Order ${order.code} transition failed: ${transitionResult.message}`, 'RazorpayPlugin');
                return { 
                    success: false, 
                    errorMessage: `Could not prepare order: ${transitionResult.message}` 
                };
            }
        } else if (order.state !== 'ArrangingPayment') {
            return { success: false, errorMessage: 'Order is already processed or paid' };
        }

        // 4. VERIFICATION: Re-fetch order to ensure state persisted and totals are updated
        const updatedOrder = await this.orderService.findOne(ctx, orderId);
        if (!updatedOrder || updatedOrder.state !== 'ArrangingPayment') {
            return { success: false, errorMessage: 'Order failed to reach ArrangingPayment state' };
        }

        // 5. Get Razorpay Config (channel-scoped)
        const paymentMethod = await this.connection.getRepository(ctx, PaymentMethod)
            .createQueryBuilder('pm')
            .leftJoin('pm.channels', 'ch')
            .where('pm.code = :code', { code: 'razorpay-payment' })
            .andWhere('ch.id = :channelId', { channelId: ctx.channelId })
            .getOne();
        if (!paymentMethod) return { success: false, errorMessage: 'Razorpay not configured for this channel' };

        const config = getRazorpayConfig(paymentMethod);
        if (!config || !config.key_id || !config.key_secret) {
            return { success: false, errorMessage: 'Razorpay API keys not configured' };
        }
        
        const instance = getRazorpayInstance({
            key_id: config.key_id,
            key_secret: config.key_secret,
        });

        // 6. PREVENT DUPLICATES: Check existing Razorpay Order ID
        const existingRzpOrderId = (updatedOrder.customFields as any).razorpayOrderId;

        if (existingRzpOrderId) {
            try {
                const rzpOrder = await instance.orders.fetch(existingRzpOrderId);

                if (rzpOrder.status === 'paid') {
                     return { success: false, errorMessage: 'This order is already paid at Razorpay' };
                }

                // Verify amount matches (in case items were added/removed before state lock)
                const currentOrderAmount = updatedOrder.totalWithTax;
                if (parseInt(rzpOrder.amount.toString()) === currentOrderAmount) {
                    // Mark payment window as open
                    await this.orderService.updateCustomFields(ctx, orderId, {
                        isPaymentWindowOpen: true
                    });
                    return {
                        success: true,
                        razorpayOrderId: existingRzpOrderId,
                        amount: currentOrderAmount,
                        currency: updatedOrder.currencyCode,
                        keyId: config.key_id,
                    };
                }
                // Tripwire: with the price lock, an order that was already waiting for
                // payment can no longer drift from its Razorpay quote. Should read zero.
                if (wasAlreadyArrangingPayment) {
                    Logger.error(
                        `[PRICE-LOCK-BREACH] order=${updatedOrder.code} razorpayOrder=${existingRzpOrderId} quoted=${rzpOrder.amount} total=${currentOrderAmount}`,
                        'RazorpayPlugin',
                    );
                }
            } catch (e) {
                Logger.warn(`Existing Razorpay ID ${existingRzpOrderId} invalid, creating new one.`, 'RazorpayPlugin');
            }
        }

        // 7. CREATE NEW RAZORPAY ORDER
        try {
            const razorpayOrder = await instance.orders.create({
                amount: updatedOrder.totalWithTax, 
                currency: updatedOrder.currencyCode,
                receipt: updatedOrder.code,
                notes: { vendureOrderId: orderId }
            });

            // Save the ID to custom fields and mark payment window as open
            await this.orderService.updateCustomFields(ctx, orderId, {
                razorpayOrderId: razorpayOrder.id,
                isPaymentWindowOpen: true
            });

            return {
                success: true,
                razorpayOrderId: razorpayOrder.id,
                amount: parseInt(razorpayOrder.amount.toString()),
                currency: razorpayOrder.currency,
                keyId: config.key_id,
            };

        } catch (error: any) {
            return {
                success: false,
                errorMessage: error.message || 'Failed to generate Razorpay Order ID'
            };
        }
    }

    /**
     * Abandon an in-flight Razorpay payment and release the order back to
     * AddingItems. Called by the storefront when the user closes the Razorpay
     * modal (modal.ondismiss) or leaves the checkout screen.
     *
     * Guardrails:
     * - Idempotent: only acts on orders in ArrangingPayment; any other state
     *   returns success with reverted=false (nothing to undo).
     * - Never reverts money-in-flight: if a Razorpay order exists it must be
     *   confirmed genuinely unpaid (getPaymentActivity === 'unpaid') before revert,
     *   so an attempt still awaiting UPI/bank approval is never yanked.
     *   On any verification uncertainty we REFUSE to revert and let the
     *   settlement path (webhook / reconciliation) complete the payment instead.
     */
    @Mutation()
    async cancelRazorpayPayment(
        @Ctx() ctx: RequestContext,
        @Args('orderId') orderId: string,
    ) {
        const order = await this.orderService.findOne(ctx, orderId);
        if (!order) return { success: false, errorMessage: 'Order not found' };
        if (!this.canAccessOrder(ctx, order)) {
            return { success: false, errorMessage: 'Unauthorized access' };
        }
        if (order.state !== 'ArrangingPayment') {
            return { success: true, reverted: false, state: order.state };
        }
        const rzpOrderId = (order.customFields as any).razorpayOrderId;
        if (rzpOrderId) {
            const client = await this.settlementService.getRazorpayClientForCtx(ctx);
            if (!client) {
                return { success: false, errorMessage: 'Cannot verify payment right now' };
            }
            // The modal closing is a hint, not proof of failure: the customer may be
            // approving in their UPI app right now. Only Razorpay's 'unpaid' reverts.
            const activity = await this.settlementService.getPaymentActivity(rzpOrderId, client);
            if (activity === 'in-progress') {
                return { success: false, errorMessage: 'Payment in progress' };
            }
            if (activity !== 'unpaid') {
                return { success: false, errorMessage: 'Payment in progress or completed' };
            }
        }
        const result = await this.orderService.transitionToState(ctx, order.id, 'AddingItems');
        if (this.isTransitionError(result)) {
            Logger.warn(`Order ${order.code} revert to AddingItems failed: ${result.message}`, 'RazorpayPlugin');
            return { success: false, errorMessage: result.message };
        }
        await this.orderService.updateCustomFields(ctx, orderId, { isPaymentWindowOpen: false });
        Logger.info(`Order ${order.code} reverted to AddingItems (payment cancelled by user)`, 'RazorpayPlugin');
        return { success: true, reverted: true, state: 'AddingItems' };
    }

    /**
     * Brings every line to the current channel price right before the cart is
     * locked for payment, so the Razorpay amount is the fresh price. A failure
     * must not block checkout (D19): the customer then pays the stored total,
     * which still matches the Razorpay amount, so settlement stays consistent.
     */
    private async repriceAtPay(ctx: RequestContext, order: Order): Promise<void> {
        try {
            await this.orderService.applyPriceAdjustments(ctx, order, order.lines);
        } catch (e: any) {
            Logger.warn(`[PRICE-LOCK] reprice at Pay failed for ${order.code}: ${e?.message}; continuing with stored totals`, 'RazorpayPlugin');
        }
    }

    /**
     * These resolvers have no @Allow, so they are public. Only the logged-in owner,
     * or the (guest) session whose active order this is, may act on the order.
     * IDs are compared with idsAreEqual: the GraphQL arg is a string, entity ids are numbers.
     */
    private canAccessOrder(ctx: RequestContext, order: Order): boolean {
        const isOwner = !!ctx.activeUserId && idsAreEqual(order.customer?.user?.id, ctx.activeUserId);
        return isOwner || idsAreEqual(ctx.session?.activeOrderId, order.id);
    }

    /**
     * Helper to detect Vendure transition error results
     */
    private isTransitionError(result: any): result is { errorCode: string; message: string } {
        return result && !!result.errorCode;
    }

    @Query()
    async getRazorpayOrderStatus(
        @Ctx() ctx: RequestContext,
        @Args('orderId') orderId: string
    ) {
        const order = await this.orderService.findOne(ctx, orderId);
        if (!order) throw new Error('Order not found');
        if (!this.canAccessOrder(ctx, order)) throw new ForbiddenError();

        const razorpayOrderId = (order.customFields as any).razorpayOrderId;
        if (!razorpayOrderId) throw new Error('No Razorpay ID found');

        const paymentMethod = await this.connection.getRepository(ctx, PaymentMethod)
            .createQueryBuilder('pm')
            .leftJoin('pm.channels', 'ch')
            .where('pm.code = :code', { code: 'razorpay-payment' })
            .andWhere('ch.id = :channelId', { channelId: ctx.channelId })
            .getOne();
        if (!paymentMethod) throw new Error('Razorpay not configured for this channel');

        const config = getRazorpayConfig(paymentMethod);
        const instance = getRazorpayInstance({ key_id: config!.key_id, key_secret: config!.key_secret });

        try {
            const rzpOrder = await instance.orders.fetch(razorpayOrderId);
            const payments = await instance.orders.fetchPayments(razorpayOrderId);

            const history = payments.items.map((p: any) => ({
                id: p.id,
                status: p.status, 
                amount: parseInt(p.amount.toString()),
                method: p.method,
                createdAt: new Date(p.created_at * 1000).toISOString(),
                errorReason: p.error_description || p.error_reason || null
            }));

            return {
                status: rzpOrder.status,
                attempts: rzpOrder.attempts,
                amountPaid: parseInt(rzpOrder.amount_paid.toString()),
                amountDue: parseInt(rzpOrder.amount_due.toString()),
                razorpayOrderId: rzpOrder.id,
                history: history
            };
        } catch (e: any) {
            throw new Error(`Razorpay Error: ${e.message}`);
        }
    }
}