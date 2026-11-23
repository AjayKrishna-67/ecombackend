import { Args, Query, Resolver } from '@nestjs/graphql';
import {
    RequestContext,
    OrderService,
    TransactionalConnection,
    Ctx,
    Allow,
    Permission,
    Order,    // Import Order
    Logger
} from '@vendure/core';
import { LessThan } from 'typeorm';
import { RazorpaySettlementService } from '../../../service/razorpay-settlement.service';

@Resolver()
export class RazorpayAdminResolver {
    constructor(
        private orderService: OrderService,
        private connection: TransactionalConnection,
        private settlementService: RazorpaySettlementService,
    ) {}

    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getRazorpayOrderStatus(
        @Ctx() ctx: RequestContext,
        @Args('orderId') orderId: string
    ) {
        // 1. Get Order & Config
        // We use 'findOne' from repo to ensure we get the latest state including payments
        const order = await this.connection.getRepository(ctx, Order).findOne({
            where: { id: orderId } as any,
            relations: ['payments', 'channels']
        });

        if (!order) throw new Error('Order not found');

        const razorpayOrderId = (order.customFields as any).razorpayOrderId;
        if (!razorpayOrderId) throw new Error('No Razorpay ID found');

        // Use the ORDER's own channel keys, not the admin's current channel: the
        // Default channel holds every city's Razorpay method, so a channel-scoped
        // lookup there picked an arbitrary account and Razorpay answered 400.
        const orderCtx = await this.settlementService.resolveChannelContext(order);
        const instance = await this.settlementService.getRazorpayClientForCtx(orderCtx);
        if (!instance) throw new Error("Razorpay not configured for this order's channel");

        try {
            // 2. Fetch Data from Razorpay
            const rzpOrder = await instance.orders.fetch(razorpayOrderId);
            const payments = await instance.orders.fetchPayments(razorpayOrderId);

            // ---------------------------------------------------------
            // SELF-HEALING LOGIC: Auto-Close if Paid
            // ---------------------------------------------------------

            // SELF-HEALING via the single settlement source of truth. Idempotent
            // (no-op if already settled) and atomic (payment insert + transition in
            // one transaction). Replaces the old inline manual heal.
            const healResult = await this.settlementService.settleFromRazorpay(orderCtx, order, instance, 'Admin Self-Heal');
            if (healResult.status === 'settled') {
                order.state = 'PaymentSettled';
            } else if (healResult.status === 'authorized') {
                order.state = 'PaymentAuthorized';
            }

            // 3. Map for GraphQL Response
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
            // The Razorpay SDK rejects with { statusCode, error: { description } }, which
            // has no .message — that is where "Razorpay Error: undefined" came from.
            throw new Error(`Razorpay Error: ${e?.error?.description ?? e?.message ?? JSON.stringify(e)}`);
        }
    }

    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getRazorpayAlerts(@Ctx() ctx: RequestContext) {
        const threshold = new Date(Date.now() - 15 * 60 * 1000);
        const staleOrders = await this.connection.getRepository(ctx, Order).find({
            where: {
                state: 'ArrangingPayment',
                updatedAt: LessThan(threshold),
            } as any
        });
        const alerts = staleOrders
            .filter(order => {
                const razorpayOrderId = (order.customFields as any)?.razorpayOrderId;
                return razorpayOrderId != null;
            })
            .map(order => ({
                orderId: order.id,
                orderCode: order.code,
                reason: 'Payment session stale or stuck in ArrangingPayment',
                stuckSince: order.updatedAt.toISOString()
            }));
        return alerts;
    }
}