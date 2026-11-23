import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    Channel,
    Customer,
    CustomerService,
    EntityHydrator,
    ID,
    Logger,
    Order,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    UserInputError,
    ChannelService,
    EventBus,
    OrderStateTransitionEvent,
} from '@vendure/core';

import { Referral, ReferralStatus } from '../entities/referral.entity';
import { ReferralChannelPoints } from '../entities/referral-channel-points.entity';
import { loggerCtx } from '../constants';

interface ReferralSummaryData {
    totalReferrals: number;
    registered: number;
    eligible: number;
    claimed: number;
}

@Injectable()
export class ReferralRewardsService implements OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private customerService: CustomerService,
        private entityHydrator: EntityHydrator,
        private requestContextService: RequestContextService,
        private channelService: ChannelService,
        private eventBus: EventBus,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async (event) => {
            Logger.info(
                `Order ${event.order.code} state transition: ${event.fromState} -> ${event.toState}`,
                loggerCtx,
            );
            if (event.toState === 'Delivered') {
                try {
                    await this.handleOrderDelivered(event.ctx, event.order);
                } catch (e: any) {
                    Logger.error(
                        `Failed to handle order delivery for referral: ${e.message}`,
                        loggerCtx,
                        e.stack,
                    );
                }
            }
        });
    }

    /**
     * Register a referral when Customer B registers using Customer A's referral link.
     * Called from the shop API when a new customer registers with a referral code.
     */
    async registerReferral(
        ctx: RequestContext,
        referrerId: ID,
        referredCustomerId: ID,
    ): Promise<Referral> {
        if (String(referrerId) === String(referredCustomerId)) {
            throw new UserInputError('Cannot refer yourself');
        }
        const referrer = await this.connection.getEntityOrThrow(ctx, Customer, referrerId);
        const referredCustomer = await this.connection.getEntityOrThrow(ctx, Customer, referredCustomerId);
        const existingReferral = await this.connection.getRepository(ctx, Referral).findOne({
            where: { referredCustomerId: Number(referredCustomerId) },
            relations: ['referrer', 'referredCustomer', 'channels'],
        });
        if (existingReferral) {
            Logger.debug(
                `Customer ${referredCustomerId} already referred by ${existingReferral.referrerId}, returning existing referral`,
                loggerCtx,
            );
            return existingReferral;
        }
        const accountAgeMs = Date.now() - new Date(referredCustomer.createdAt).getTime();
        const twentyFourHoursMs = 24 * 60 * 60 * 1000;
        if (accountAgeMs > twentyFourHoursMs) {
            throw new UserInputError(
                'Referral is only valid within 24 hours of account creation',
            );
        }
        const referral = new Referral({
            referrer,
            referrerId: Number(referrerId),
            referredCustomer,
            referredCustomerId: Number(referredCustomerId),
            status: ReferralStatus.REGISTERED,
            points: 0,
            isScratched: false,
            note: `Referral registered: Customer ${referrerId} referred Customer ${referredCustomerId}`,
        });
        const saved = await this.connection.getRepository(ctx, Referral).save(referral);
        await this.channelService.assignToChannels(ctx, Referral, saved.id, [ctx.channelId]);
        Logger.info(
            `Referral registered: ${referrerId} -> ${referredCustomerId} (channel: ${ctx.channelId})`,
            loggerCtx,
        );
        return this.connection.getRepository(ctx, Referral).findOneOrFail({
            where: { id: saved.id },
            relations: ['referrer', 'referredCustomer', 'channels'],
        });
    }

    /**
     * When Customer B's first order is delivered, make the referral eligible.
     * Points are determined by the channel the order was placed in.
     */
    async handleOrderDelivered(ctx: RequestContext, order: Order): Promise<void> {
        Logger.info(`[handleOrderDelivered] Processing order ${order.code} (id: ${order.id})`, loggerCtx);
        await this.entityHydrator.hydrate(ctx, order, { relations: ['customer', 'channels'] });
        const customer = order.customer;
        if (!customer) {
            Logger.warn(`[handleOrderDelivered] No customer found on order ${order.code}`, loggerCtx);
            return;
        }
        Logger.info(`[handleOrderDelivered] Order customer: ${customer.id} (${customer.firstName})`, loggerCtx);
        // Use the order's channel (not the event ctx channel which may be default/admin channel)
        const orderChannel = order.channels?.find((ch: Channel) => ch.code !== '__default_channel__') ?? order.channels?.[0];
        let orderCtx = ctx;
        if (orderChannel && orderChannel.id !== ctx.channelId) {
            Logger.info(
                `[handleOrderDelivered] Order channel (${orderChannel.code}) differs from ctx channel (${ctx.channelId}), creating order channel context`,
                loggerCtx,
            );
            orderCtx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: orderChannel.token,
            });
        }
        const referral = await this.connection.getRepository(orderCtx, Referral).findOne({
            where: {
                referredCustomerId: Number(customer.id),
                status: ReferralStatus.REGISTERED,
            },
            relations: ['referrer', 'channels'],
        });
        if (!referral) {
            Logger.info(`[handleOrderDelivered] No REGISTERED referral found for customer ${customer.id}`, loggerCtx);
            return;
        }
        Logger.info(`[handleOrderDelivered] Found referral ${referral.id} for customer ${customer.id}, referrer: ${referral.referrerId}`, loggerCtx);
        const isFirstDeliveredOrder = await this.isFirstDeliveredOrder(orderCtx, customer.id, order.id);
        if (!isFirstDeliveredOrder) {
            Logger.debug(
                `Order ${order.code} is not first delivered order for customer ${customer.id}, skipping referral`,
                loggerCtx,
            );
            return;
        }
        const channelPoints = await this.getReferralChannelPoints(orderCtx);
        const points = channelPoints?.points ?? 0;
        if (points <= 0) {
            Logger.warn(
                `No referral points configured for channel ${ctx.channelId}`,
                loggerCtx,
            );
            return;
        }
        referral.status = ReferralStatus.ELIGIBLE;
        referral.points = points;
        referral.order = order;
        referral.note = `Referral eligible: ${points} points earned from order ${order.code} in channel ${orderCtx.channel?.code ?? orderCtx.channelId}`;
        await this.connection.getRepository(orderCtx, Referral).save(referral);
        Logger.info(
            `Referral ${referral.id} now eligible: ${points} points for referrer ${referral.referrerId}`,
            loggerCtx,
        );
    }

    /**
     * Check if this is the customer's first delivered order.
     */
    private async isFirstDeliveredOrder(
        ctx: RequestContext,
        customerId: ID,
        currentOrderId: ID,
    ): Promise<boolean> {
        const deliveredOrders = await this.connection.getRepository(ctx, Order).find({
            where: {
                customer: { id: customerId },
                state: 'Delivered',
            },
            order: { createdAt: 'ASC' },
            take: 1,
        });
        return deliveredOrders.length > 0 && String(deliveredOrders[0].id) === String(currentOrderId);
    }

    /**
     * Scratch the referral card — reveals and adds points to loyalty wallet.
     * Called from shop API by the referrer (Customer A).
     */
    async scratchReferralCard(ctx: RequestContext, referralId: ID): Promise<Referral> {
        const referral = await this.connection.getRepository(ctx, Referral).findOne({
            where: { id: referralId },
            relations: ['referrer', 'channels'],
        });
        if (!referral) {
            throw new UserInputError('Referral not found');
        }
        if (referral.status === ReferralStatus.CLAIMED || referral.isScratched) {
            throw new UserInputError('Referral card has already been scratched and claimed');
        }
        if (referral.status === ReferralStatus.REGISTERED) {
            throw new UserInputError('Referral is not yet eligible — referred customer has no delivered order');
        }
        if (referral.status !== ReferralStatus.ELIGIBLE) {
            throw new UserInputError('Referral is not eligible for claiming');
        }
        const activeUserId = ctx.activeUserId;
        if (!activeUserId) {
            throw new UserInputError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, activeUserId);
        if (!customer || String(customer.id) !== String(referral.referrerId)) {
            throw new UserInputError('Only the referrer can scratch this card');
        }
        referral.isScratched = true;
        referral.status = ReferralStatus.CLAIMED;
        referral.note = `Scratched and claimed: ${referral.points} points added to loyalty wallet`;
        await this.connection.getRepository(ctx, Referral).save(referral);
        const referrer = await this.connection.getEntityOrThrow(ctx, Customer, referral.referrerId);
        referrer.customFields.loyaltyPointsAvailable =
            (referrer.customFields.loyaltyPointsAvailable || 0) + referral.points;
        await this.connection.getRepository(ctx, Customer).save(referrer, { reload: false });
        Logger.info(
            `Referral ${referralId} scratched: ${referral.points} points added to customer ${referral.referrerId}`,
            loggerCtx,
        );
        return referral;
    }

    /**
     * Scratch a referral card by referralNumber (per-customer sequential number).
     * Resolves the referralNumber to the actual referral entity, then scratches it.
     */
    async scratchReferralCardByNumber(ctx: RequestContext, referralNumber: number): Promise<Referral> {
        const activeUserId = ctx.activeUserId;
        if (!activeUserId) {
            throw new UserInputError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, activeUserId);
        if (!customer) {
            throw new UserInputError('No customer found');
        }
        const referrals = await this.connection.getRepository(ctx, Referral).find({
            where: { referrerId: Number(customer.id) },
            order: { id: 'ASC' },
        });
        if (referralNumber < 1 || referralNumber > referrals.length) {
            throw new UserInputError(`Referral number ${referralNumber} not found`);
        }
        const referral = referrals[referralNumber - 1];
        return this.scratchReferralCard(ctx, referral.id);
    }

    /**
     * Get all referrals for a customer (as referrer) — used in shop API for scratch card list.
     */
    async getMyReferrals(
        ctx: RequestContext,
        take: number = 10,
        skip: number = 0,
        status?: string,
    ): Promise<{ items: Referral[]; totalItems: number }> {
        const activeUserId = ctx.activeUserId;
        if (!activeUserId) {
            throw new UserInputError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, activeUserId);
        if (!customer) {
            throw new UserInputError('No customer found');
        }
        const qb = this.connection.getRepository(ctx, Referral)
            .createQueryBuilder('referral')
            .leftJoinAndSelect('referral.referredCustomer', 'referredCustomer')
            .leftJoinAndSelect('referral.order', 'order')
            .leftJoinAndSelect('referral.channels', 'channel')
            .where('referral.referrerId = :referrerId', { referrerId: Number(customer.id) });
        if (status) {
            qb.andWhere('referral.status = :status', { status });
        }
        qb.orderBy('referral.createdAt', 'DESC')
            .take(take)
            .skip(skip);
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    /**
     * Get earned scratch cards (ELIGIBLE status — ready to scratch).
     */
    async getEarnedScratchCards(
        ctx: RequestContext,
        take: number = 10,
        skip: number = 0,
    ): Promise<{ items: Referral[]; totalItems: number }> {
        const activeUserId = ctx.activeUserId;
        if (!activeUserId) {
            throw new UserInputError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, activeUserId);
        if (!customer) {
            throw new UserInputError('No customer found');
        }
        const qb = this.connection.getRepository(ctx, Referral)
            .createQueryBuilder('referral')
            .leftJoinAndSelect('referral.referredCustomer', 'referredCustomer')
            .leftJoinAndSelect('referral.order', 'order')
            .leftJoinAndSelect('referral.channels', 'channel')
            .where('referral.referrerId = :referrerId', { referrerId: Number(customer.id) })
            .andWhere('referral.status = :status', { status: ReferralStatus.ELIGIBLE })
            .andWhere('referral.isScratched = :isScratched', { isScratched: false })
            .orderBy('referral.createdAt', 'DESC')
            .take(take)
            .skip(skip);
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    /**
     * Get scratched cards (CLAIMED status — already scratched and points added).
     */
    async getScratchedCards(
        ctx: RequestContext,
        take: number = 10,
        skip: number = 0,
    ): Promise<{ items: Referral[]; totalItems: number }> {
        const activeUserId = ctx.activeUserId;
        if (!activeUserId) {
            throw new UserInputError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, activeUserId);
        if (!customer) {
            throw new UserInputError('No customer found');
        }
        const qb = this.connection.getRepository(ctx, Referral)
            .createQueryBuilder('referral')
            .leftJoinAndSelect('referral.referredCustomer', 'referredCustomer')
            .leftJoinAndSelect('referral.order', 'order')
            .leftJoinAndSelect('referral.channels', 'channel')
            .where('referral.referrerId = :referrerId', { referrerId: Number(customer.id) })
            .andWhere('referral.status = :status', { status: ReferralStatus.CLAIMED })
            .andWhere('referral.isScratched = :isScratched', { isScratched: true })
            .orderBy('referral.updatedAt', 'DESC')
            .take(take)
            .skip(skip);
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    /**
     * Check and update referral eligibility for a referred customer.
     * Handles case where order was delivered before referral was registered.
     */
    async checkAndUpdateEligibility(
        ctx: RequestContext,
        referralId: ID,
    ): Promise<Referral> {
        const referral = await this.connection.getRepository(ctx, Referral).findOne({
            where: { id: referralId },
            relations: ['referrer', 'referredCustomer', 'order', 'channels'],
        });
        if (!referral) {
            throw new UserInputError('Referral not found');
        }
        if (referral.status !== ReferralStatus.REGISTERED) {
            return referral;
        }
        const deliveredOrder = await this.connection.getRepository(ctx, Order).findOne({
            where: {
                customer: { id: referral.referredCustomerId },
                state: 'Delivered',
            },
            order: { createdAt: 'ASC' },
        });
        if (!deliveredOrder) {
            throw new UserInputError('Referred customer has no delivered orders yet');
        }
        const channelPoints = await this.getReferralChannelPoints(ctx);
        const points = channelPoints?.points ?? 0;
        if (points <= 0) {
            throw new UserInputError(`No referral points configured for this channel`);
        }
        referral.status = ReferralStatus.ELIGIBLE;
        referral.points = points;
        referral.order = deliveredOrder;
        referral.note = `Referral eligible: ${points} points earned from order ${deliveredOrder.code}`;
        await this.connection.getRepository(ctx, Referral).save(referral);
        Logger.info(
            `Referral ${referralId} manually updated to eligible: ${points} points`,
            loggerCtx,
        );
        return referral;
    }

    /**
     * Check if a customer was referred by someone.
     */
    async getReferredByForCustomer(
        ctx: RequestContext,
        customerId: ID,
    ): Promise<Referral | null> {
        const referral = await this.connection.getRepository(ctx, Referral).findOne({
            where: { referredCustomerId: Number(customerId) },
            relations: ['referrer', 'referredCustomer', 'channels'],
        });
        return referral ?? null;
    }

    /**
     * Get referrals for a specific customer (admin API).
     * Uses QueryBuilder for reliable ManyToMany channel filtering.
     */
    async getReferralsForCustomer(
        ctx: RequestContext,
        customerId: ID,
        take: number = 10,
        skip: number = 0,
    ): Promise<{ items: Referral[]; totalItems: number }> {
        const [items, totalItems] = await this.connection.getRepository(ctx, Referral).findAndCount({
            where: { referrerId: Number(customerId) },
            relations: ['referrer', 'referredCustomer', 'order', 'channels'],
            order: { createdAt: 'DESC' },
            take,
            skip,
        });
        return { items, totalItems };
    }

    /**
     * Get all referrals (admin API).
     * Uses QueryBuilder for reliable ManyToMany channel filtering.
     */
    async getAllReferrals(
        ctx: RequestContext,
        take: number = 25,
        skip: number = 0,
    ): Promise<{ items: Referral[]; totalItems: number }> {
        const qb = this.connection.getRepository(ctx, Referral)
            .createQueryBuilder('referral')
            .innerJoin('referral.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
            .leftJoinAndSelect('referral.referrer', 'referrer')
            .leftJoinAndSelect('referral.referredCustomer', 'referredCustomer')
            .leftJoinAndSelect('referral.order', 'order')
            .leftJoinAndSelect('referral.channels', 'channels')
            .orderBy('referral.createdAt', 'DESC')
            .take(take)
            .skip(skip);
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    // --- Referral Channel Points Config ---

    async getReferralChannelPoints(ctx: RequestContext): Promise<ReferralChannelPoints | null> {
        const result = await this.connection.getRepository(ctx, ReferralChannelPoints)
            .createQueryBuilder('config')
            .innerJoin('config.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId })
            .leftJoinAndSelect('config.channels', 'channels')
            .getOne();
        return result ?? null;
    }

    async createReferralChannelPoints(
        ctx: RequestContext,
        points: number,
    ): Promise<ReferralChannelPoints> {
        const existing = await this.getReferralChannelPoints(ctx);
        if (existing) {
            throw new UserInputError(
                'Referral points configuration already exists for this channel. Use update instead.',
            );
        }
        if (points < 0) {
            throw new UserInputError('Points must be zero or greater');
        }
        const config = new ReferralChannelPoints({ points });
        const saved = await this.connection.getRepository(ctx, ReferralChannelPoints).save(config);
        await this.channelService.assignToChannels(ctx, ReferralChannelPoints, saved.id, [ctx.channelId]);
        return this.connection.getRepository(ctx, ReferralChannelPoints).findOneOrFail({
            where: { id: saved.id },
            relations: ['channels'],
        });
    }

    async updateReferralChannelPoints(
        ctx: RequestContext,
        id: ID,
        points: number,
    ): Promise<ReferralChannelPoints> {
        const config = await this.getReferralChannelPoints(ctx);
        if (!config || String(config.id) !== String(id)) {
            throw new UserInputError('No referral points config found for this channel');
        }
        if (points < 0) {
            throw new UserInputError('Points must be zero or greater');
        }
        config.points = points;
        await this.connection.getRepository(ctx, ReferralChannelPoints).save(config);
        return this.connection.getRepository(ctx, ReferralChannelPoints).findOneOrFail({
            where: { id: config.id },
            relations: ['channels'],
        });
    }

    /**
     * Get referral summary stats grouped by time period.
     * Uses QueryBuilder for reliable ManyToMany channel filtering.
     */
    async getReferralSummary(ctx: RequestContext): Promise<{
        today: ReferralSummaryData;
        yesterday: ReferralSummaryData;
        allTime: ReferralSummaryData;
    }> {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        const [today, yesterday, allTime] = await Promise.all([
            this.getSummaryForPeriod(ctx, todayStart, now),
            this.getSummaryForPeriod(ctx, yesterdayStart, todayStart),
            this.getSummaryForPeriod(ctx, null, null),
        ]);
        return { today, yesterday, allTime };
    }

    private async getSummaryForPeriod(
        ctx: RequestContext,
        from: Date | null,
        to: Date | null,
    ): Promise<ReferralSummaryData> {
        const baseQb = () => {
            const qb = this.connection.getRepository(ctx, Referral)
                .createQueryBuilder('referral')
                .innerJoin('referral.channels', 'channel', 'channel.id = :channelId', { channelId: ctx.channelId });
            if (from && to) {
                qb.andWhere('referral.createdAt BETWEEN :from AND :to', { from, to });
            }
            return qb;
        };
        const [totalReferrals, registered, eligible, claimed] = await Promise.all([
            baseQb().getCount(),
            baseQb().andWhere('referral.status = :status', { status: ReferralStatus.REGISTERED }).getCount(),
            baseQb().andWhere('referral.status = :status', { status: ReferralStatus.ELIGIBLE }).getCount(),
            baseQb().andWhere('referral.status = :status', { status: ReferralStatus.CLAIMED }).getCount(),
        ]);
        return { totalReferrals, registered, eligible, claimed };
    }

    async deleteReferralChannelPoints(ctx: RequestContext, id: ID): Promise<boolean> {
        const config = await this.getReferralChannelPoints(ctx);
        if (!config || String(config.id) !== String(id)) {
            throw new UserInputError('No referral points config found for this channel');
        }
        await this.connection.getRepository(ctx, ReferralChannelPoints).remove(config);
        return true;
    }
}
