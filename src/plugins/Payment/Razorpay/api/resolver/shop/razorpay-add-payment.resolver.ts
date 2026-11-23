import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { MutationAddPaymentToOrderArgs, PaymentInput } from '@vendure/common/lib/generated-shop-types';
import {
    ACTIVE_ORDER_INPUT_FIELD_NAME,
    ActiveOrderService,
    Allow,
    Ctx,
    CustomerService,
    idsAreEqual,
    isGraphQlErrorResult,
    Logger,
    Order,
    OrderService,
    Permission,
    RequestContext,
    SessionService,
    TransactionalConnection,
} from '@vendure/core';
import { NoActiveOrderError } from '@vendure/core/dist/common/error/generated-graphql-shop-errors';
import { razorpayPaymentHandler } from '../../../handler/razorpay.handler';
import { RazorpaySettlementService } from '../../../service/razorpay-settlement.service';
import { isChecksumVerified } from '../../../utils/razorpay-utils';

type AddPaymentArgs = MutationAddPaymentToOrderArgs & { [ACTIVE_ORDER_INPUT_FIELD_NAME]?: unknown };

/**
 * The Android app's GraphQL client (graphql 5.2) gives up after 5 s and then shows
 * "Failed to add payment" even when the order is placed. Slower answers are logged.
 */
const SLOW_ADD_PAYMENT_MS = 4_000;

/**
 * Overrides the built-in shop `addPaymentToOrder` so a Razorpay payment the
 * webhook already recorded is answered with its placed order, not an error.
 *
 * Razorpay sends payment.captured within a second of the payment, often before
 * the app is back from the checkout. The webhook then places the order first,
 * and core answers the app's addPaymentToOrder with NoActiveOrderError (or,
 * when the two overlap, the handler's "Payment already recorded" decline). The
 * app treats that as a failed payment and stays on the checkout page although
 * the order is paid (order 64574). Nothing is recorded twice: the fallback
 * below only reads.
 */
@Resolver()
export class RazorpayAddPaymentResolver {
    constructor(
        private orderService: OrderService,
        private activeOrderService: ActiveOrderService,
        private customerService: CustomerService,
        private sessionService: SessionService,
        private connection: TransactionalConnection,
        private settlementService: RazorpaySettlementService,
    ) {}

    /**
     * Not @Transaction(): the fallback must run after core's transaction has
     * committed, so it reads what the webhook committed meanwhile. Inside the
     * transaction MySQL's REPEATABLE READ snapshot would still show the order unpaid.
     */
    @Mutation()
    @Allow(Permission.Owner)
    async addPaymentToOrder(@Ctx() ctx: RequestContext, @Args() args: AddPaymentArgs) {
        const startedAt = Date.now();
        const result = await this.connection.withTransaction(ctx, txCtx => this.addPaymentToActiveOrder(txCtx, args));
        const placedOrder = isGraphQlErrorResult(result) ? await this.findOrderAlreadyPaidBy(ctx, args.input) : undefined;
        const answer = placedOrder ?? result;
        const elapsedMs = Date.now() - startedAt;
        if (placedOrder) {
            Logger.info(`[AddPayment] ${placedOrder.code}: payment was already recorded (webhook was first); returned the placed order in ${elapsedMs} ms`, 'RazorpayPlugin');
        }
        if (elapsedMs > SLOW_ADD_PAYMENT_MS) {
            const outcome = isGraphQlErrorResult(answer) ? answer.errorCode : `order ${answer.code} ${answer.state}`;
            Logger.warn(`[AddPayment] slow: ${elapsedMs} ms (${outcome}); the app gives up after 5 s`, 'RazorpayPlugin');
        }
        return answer;
    }

    /** Core's shop addPaymentToOrder resolver, same steps (shop-order.resolver.js). */
    private async addPaymentToActiveOrder(ctx: RequestContext, args: AddPaymentArgs) {
        if (!ctx.authorizedAsOwnerOnly) {
            return new NoActiveOrderError();
        }
        const sessionOrder = await this.activeOrderService.getActiveOrder(ctx, args[ACTIVE_ORDER_INPUT_FIELD_NAME] as any);
        if (!sessionOrder) {
            return new NoActiveOrderError();
        }
        const order = await this.orderService.addPaymentToOrder(ctx, sessionOrder.id, args.input);
        if (isGraphQlErrorResult(order) || order.active !== false) {
            return order;
        }
        await this.customerService.createAddressesForNewCustomer(ctx, order);
        if (ctx.session && idsAreEqual(ctx.session.activeOrderId, sessionOrder.id)) {
            await this.sessionService.unsetActiveOrder(ctx, ctx.session);
        }
        return order;
    }

    /**
     * The order this Razorpay payment is already recorded on (Settled or
     * Authorized), when the caller proves it made the payment: Razorpay's
     * checkout signature, plus being logged in as the order's account if it has one.
     */
    private async findOrderAlreadyPaidBy(ctx: RequestContext, input: PaymentInput): Promise<Order | undefined> {
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = input.metadata ?? {};
        if (input.method !== razorpayPaymentHandler.code || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return undefined;
        }
        const order = await this.connection.getRepository(ctx, Order).findOne({
            where: { customFields: { razorpayOrderId } } as any,
            relations: ['payments', 'channels', 'customer', 'customer.user'],
        });
        const isRecorded = order?.payments?.some(
            p => p.transactionId === razorpayPaymentId && (p.state === 'Settled' || p.state === 'Authorized'),
        );
        if (!order || !isRecorded || !order.channels.some(c => idsAreEqual(c.id, ctx.channelId))) {
            return undefined;
        }
        const accountUser = order.customer?.user;
        if (accountUser && !idsAreEqual(accountUser.id, ctx.activeUserId)) {
            return undefined;
        }
        const config = await this.settlementService.getRazorpayConfigForCtx(ctx);
        if (!config || !isChecksumVerified({ razorpaySignature, razorpayOrderId, razorpayPaymentId, secretKey: config.key_secret })) {
            return undefined;
        }
        return this.orderService.findOne(ctx, order.id);
    }
}
