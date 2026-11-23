import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import {

  CacheService,

  Customer,

  CustomerService,

  EntityHydrator,

  ID,

  Logger,

  Order,

  OrderCalculator,

  OrderService,

  PaymentMethodService,

  PromotionService,

  Refund,

  RequestContext,

  RequestContextService,

  TransactionalConnection,

  UserInputError,

  ShippingLine,

  ChannelService,

  OrderPlacedEvent,

  EventBus,

} from '@vendure/core';

const LOYALTY_CONFIG_TTL_MS = 60 * 60 * 1000; // 1h — rarely changes

const LOYALTY_CONFIG_TAG_ALL = 'loyalty-config:all';

const loyaltyConfigTag = (channelId: ID) => `loyalty-config:channel:${channelId}`;

const loyaltyConfigKey = (channelId: ID) => `loyalty-config:channel:${channelId}`;

import { LoyaltyPointsTransaction } from '../entities/loyalty-points-transaction.entity';

import { LoyaltyPointsConfig } from '../entities/loyalty-points-config.entity';

import { LoyaltyPointsTransactionInput, LoyaltyTransactionType } from '../gql/generated';

import { loggerCtx } from '../constants';


@Injectable()

export class LoyaltyPointsService implements OnApplicationBootstrap {

  constructor(

    private connection: TransactionalConnection,

    private promotionService: PromotionService,

    private customerService: CustomerService,

    private orderService: OrderService,

    private orderCalculator: OrderCalculator,

    private entityHydrator: EntityHydrator,

    private paymentMethodService: PaymentMethodService,

    private requestContextService: RequestContextService,

    private channelService: ChannelService,

    private eventBus: EventBus,

    private cacheService: CacheService,

  ) { }

  private async invalidateLoyaltyConfigCache(channelId: ID): Promise<void> {

    await this.cacheService.invalidateTags([loyaltyConfigTag(channelId)]);

    Logger.debug(`[LoyaltyPointsService] Config cache invalidated for channel ${channelId}`, loggerCtx);

  }


  async onApplicationBootstrap() {

    try {

      await this.ensureLoyaltyPointsConfigExists();

    } catch (error: any) {

      Logger.error(`Failed to ensure LoyaltyPointsConfig: ${error.message}`, loggerCtx, error.stack);

    }



    this.eventBus.ofType(OrderPlacedEvent).subscribe(async ({ ctx, order }) => {

      try {

        await this.handleOrderPlacedEvent(ctx, order);

      } catch (e: any) {

        Logger.error(`Failed to handle OrderPlacedEvent for LoyaltyPoints: ${e.message}`, loggerCtx, e.stack);

      }

    });

  }


  async ensureLoyaltyPointsConfigExists() {

    const ctx = await this.requestContextService.create({ apiType: 'admin' });

    try {

      const config = await this.getLoyaltyPointsConfig(ctx);

      if (!config) {

        Logger.info(`No LoyaltyPointsConfig found for channel ${ctx.channelId}, creating default config`, loggerCtx);

        await this.createLoyaltyPointsConfig(ctx, { rupeesPerPoint: 100, pointsPerRupee: 1 });

        Logger.info(`Created default LoyaltyPointsConfig for channel ${ctx.channelId}`, loggerCtx);

        return;

      }

    } catch (error: any) {

      Logger.error(`Error accessing LoyaltyPointsConfig: ${error.message}`, loggerCtx, error.stack);

    }

  }


  async handleOrderPlacedEvent(ctx: RequestContext, order: Order) {

    // 1. Fetch Config

    const config = await this.getLoyaltyPointsConfig(ctx);

    if (!config) {

      Logger.error(`No LoyaltyPointsConfig found for channel ${ctx.channelId}`, loggerCtx);

      return;

    }


    // 2. Fetch fresh order (Just to get accurate subTotal, no relations needed now)

    const orderRepo = this.connection.getRepository(ctx, Order);

    // We don't need relations: ['lines'] anymore because we are NOT calling .save()

    const freshOrder = await orderRepo.findOne({ where: { id: order.id } });


    if (!freshOrder) return;


    // 3. Calculate Points

    const orderAmountInRupees = freshOrder.subTotalWithTax / 100;

    const pointsEarned = Math.ceil(orderAmountInRupees / config.rupeesPerPoint);

    if (pointsEarned <= 0) {

      return;

    }


    // 4. Idempotency Check

    const existing = await this.connection.getRepository(ctx, LoyaltyPointsTransaction).findOne({

      where: { order: { id: order.id }, type: LoyaltyTransactionType.EARNED_ON_ORDER, channels: { id: ctx.channelId } },

    });

    if (existing) {

      Logger.debug(`Points already awarded for order ${order.code}`, loggerCtx);

      return;

    }


    // 5. Hydrate Customer (Required for Transaction creation)

    await this.entityHydrator.hydrate(ctx, freshOrder, { relations: ['customer'] });

    const customer = freshOrder.customer;

    if (!customer) {

      Logger.warn(`No customer found for order ${order.code}`, loggerCtx);

      return;

    }


    // 6. Create Transaction Record

    const transaction = new LoyaltyPointsTransaction({

      customer,

      order: freshOrder,

      note: `Earned ${pointsEarned} points from order ${order.code}`,

      type: LoyaltyTransactionType.EARNED_ON_ORDER,

      value: pointsEarned,

      code: `${LoyaltyTransactionType.EARNED_ON_ORDER}-${order.code}-${Date.now()}`,

    });

    await this.channelService.assignToCurrentChannel(transaction, ctx);

    await this.connection.getRepository(ctx, LoyaltyPointsTransaction).save(transaction);


    // 7. UPDATE ORDER - THE FIX

    // We use .update() instead of .save(). 

    // This sends a direct "UPDATE order SET customFields = ... WHERE id = ..."

    // It bypasses the 'discounts' calculation check and the version lock.

    await orderRepo.update(

      { id: freshOrder.id },

      { customFields: { loyaltyPointsEarned: pointsEarned } }

    );

    Logger.info(`Updated order ${order.code} with loyaltyPointsEarned: ${pointsEarned}`, loggerCtx);


    // 8. Update Customer Points

    // (Customer updates are usually safe to use .save() as they don't conflict with Order State)

    customer.customFields.loyaltyPointsAvailable = (customer.customFields.loyaltyPointsAvailable || 0) + pointsEarned;

    await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });



    Logger.info(

      `Awarded ${pointsEarned} points for order ${order.code}, updated customer loyaltyPointsAvailable`,

      loggerCtx

    );

  }


  // Helper just in case

  async addPointsFromOrder(ctx: RequestContext, order: Order): Promise<void> {

    await this.handleOrderPlacedEvent(ctx, order);

  }


  async updateOrderWithPointsEarned(ctx: RequestContext, order: Order, pointsEarned: number): Promise<void> {

    // 1. Update the Database

    await this.connection.getRepository(ctx, Order).update(

      { id: order.id },

      { customFields: { loyaltyPointsEarned: pointsEarned } }

    );


    // 2. [THE FIX] Update the In-Memory Object so the API response is correct

    if (order.customFields) {

      order.customFields.loyaltyPointsEarned = pointsEarned;

    }

  }


  async handleOrderCancelled(ctx: RequestContext, order: Order): Promise<void> {
    await this.entityHydrator.hydrate(ctx, order, { relations: ['customer'] });
    const customer = order.customer;
    if (!customer) {
      Logger.warn(`No customer found for cancelled order ${order.code}`, loggerCtx);
      return;
    }

    const orderRepo = this.connection.getRepository(ctx, Order);
    const txRepo = this.connection.getRepository(ctx, LoyaltyPointsTransaction);
    const customerRepo = this.connection.getRepository(ctx, Customer);

    // Reverse earned points if any
    const earnedTransaction = await txRepo.findOne({
      where: { order: { id: order.id }, type: LoyaltyTransactionType.EARNED_ON_ORDER, channels: { id: ctx.channelId } },
    });

    if (earnedTransaction) {
      const pointsToReverse = earnedTransaction.value;
      await txRepo.remove(earnedTransaction);
      customer.customFields.loyaltyPointsAvailable = Math.max(
        0,
        (customer.customFields.loyaltyPointsAvailable || 0) - pointsToReverse,
      );
      await customerRepo.save(customer, { reload: false });
      await orderRepo.update({ id: order.id }, { customFields: { loyaltyPointsEarned: 0 } });
      Logger.info(`Reversed ${pointsToReverse} earned points for cancelled order ${order.code}`, loggerCtx);
    }

    // Restore used points if any
    const usedTransaction = await txRepo.findOne({
      where: { order: { id: order.id }, type: LoyaltyTransactionType.USED_ON_ORDER, channels: { id: ctx.channelId } },
    });

    if (usedTransaction) {
      const pointsToRestore = Math.abs(usedTransaction.value);
      await txRepo.remove(usedTransaction);
      customer.customFields.loyaltyPointsAvailable = (customer.customFields.loyaltyPointsAvailable || 0) + pointsToRestore;
      await customerRepo.save(customer, { reload: false });
      await orderRepo.update({ id: order.id }, { customFields: { loyaltyPointsUsed: 0 } });
      Logger.info(`Restored ${pointsToRestore} used points for cancelled order ${order.code}`, loggerCtx);
    }
  }

  async removePointsFromRefundedOrder(ctx: RequestContext, order: Order, refund: Refund) {

    await this.entityHydrator.hydrate(ctx, order, { relations: ['customer'] });

    const customer = order.customer;

    if (!customer) {

      Logger.warn(`No customer found for order ${order.code}`, loggerCtx);

      return;

    }

    const config = await this.getLoyaltyPointsConfig(ctx);

    if (!config) {

      throw new Error('No LoyaltyPointsConfig found');

    }

    const refundAmountInRupees = refund.items / 100;

    const pointsToDeduct = Math.floor(refundAmountInRupees / config.rupeesPerPoint);

    if (pointsToDeduct <= 0) {

      Logger.info(`No points to deduct for refund on order ${order.code}`, loggerCtx);

      return;

    }

    const transaction = new LoyaltyPointsTransaction({

      customer,

      order,

      note: refund.reason ?? `Refunded ${pointsToDeduct} points for order ${order.code}`,

      type: LoyaltyTransactionType.ORDER_CANCELLED,

      value: -pointsToDeduct,

      code: `${LoyaltyTransactionType.ORDER_CANCELLED}-${order.code}-${Date.now()}`,

    });

    await this.channelService.assignToCurrentChannel(transaction, ctx);

    await this.connection.getRepository(ctx, LoyaltyPointsTransaction).save(transaction);

    customer.customFields.loyaltyPointsAvailable = Math.max(0, (customer.customFields.loyaltyPointsAvailable || 0) - pointsToDeduct);

    await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

    Logger.info(`Deducted ${pointsToDeduct} points for refund on order ${order.code}`, loggerCtx);

  }


  async createPointsAdjustment(ctx: RequestContext, input: LoyaltyPointsTransactionInput): Promise<LoyaltyPointsTransaction> {

    const customer = await this.connection.getEntityOrThrow(ctx, Customer, input.customerId);

    if ((customer.customFields.loyaltyPointsAvailable || 0) + input.value < 0) {

      throw new UserInputError('Cannot adjust reward points below zero');

    }

    const transaction = new LoyaltyPointsTransaction({

      type: LoyaltyTransactionType.ADMINISTRATOR_ADJUSTED,

      customer,

      value: input.value,

      note: input.note,

      code: `ADJ-${customer.id}-${Date.now()}`,

    });

    await this.channelService.assignToCurrentChannel(transaction, ctx);

    return this.connection.getRepository(ctx, LoyaltyPointsTransaction).save(transaction);

  }


  async applyLoyaltyPointsToActiveOrder(ctx: RequestContext, amount: number): Promise<Order | undefined> {

    Logger.info(`Applying ${amount} loyalty points to order`, loggerCtx);

    if (!ctx.session?.activeOrderId || !ctx.activeUserId) {

      throw new UserInputError('No active order or user found');

    }

    const order = await this.connection.getEntityOrThrow(ctx, Order, ctx.session.activeOrderId, {

      channelId: ctx.channelId,

      relations: ['customer', 'lines', 'lines.productVariant', 'shippingLines', 'surcharges'],

    });

    const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);

    if (!customer || !order) {

      throw new UserInputError('No customer or order found');

    }

    const config = await this.getLoyaltyPointsConfig(ctx);

    if (!config) {

      throw new Error('No LoyaltyPointsConfig found');

    }

    const existingEarnedTransaction = await this.connection.getRepository(ctx, LoyaltyPointsTransaction).findOne({

      where: { order: { id: order.id }, type: LoyaltyTransactionType.EARNED_ON_ORDER, channels: { id: ctx.channelId } },

    });

    if (amount <= 0) {

      Logger.info(`No points applied for order ${order.code}`, loggerCtx);

      return order;

    }

    const effectivePointsUsed = this.effectiveLoyaltyPointsUsed(order, customer, amount);

    if (effectivePointsUsed <= 0) {

      Logger.warn(`No valid points to apply for order ${order.code}`, loggerCtx);

      return order;

    }

    if (existingEarnedTransaction) {

      const pointsToReverse = existingEarnedTransaction.value;

      await this.connection.getRepository(ctx, LoyaltyPointsTransaction).remove(existingEarnedTransaction);

      customer.customFields.loyaltyPointsAvailable = Math.max(0, (customer.customFields.loyaltyPointsAvailable || 0) - pointsToReverse);

      await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

      Logger.info(`Reversed ${pointsToReverse} earned points for order ${order.code}`, loggerCtx);

    }

    const discountInRupees = Math.floor(effectivePointsUsed / config.pointsPerRupee);

    const subTotalInRupees = order.subTotalWithTax / 100;

    const cappedDiscountInRupees = Math.min(discountInRupees, subTotalInRupees);

    const cappedPointsUsed = cappedDiscountInRupees * config.pointsPerRupee;

    if (cappedPointsUsed !== effectivePointsUsed) {

      Logger.warn(`Capped discount from ₹${discountInRupees} to ₹${cappedDiscountInRupees} to avoid negative total for order ${order.code}`, loggerCtx);

    }

    const discountInCents = cappedDiscountInRupees * 100;

    const existingUsedTransaction = await this.connection.getRepository(ctx, LoyaltyPointsTransaction).findOne({

      where: { order: { id: order.id }, type: LoyaltyTransactionType.USED_ON_ORDER, channels: { id: ctx.channelId } },

    });

    if (existingUsedTransaction) {

      Logger.info(`Transaction already exists for order ${order.code}, skipping new deduction`, loggerCtx);

      return order;

    }

    const transaction = new LoyaltyPointsTransaction({

      customer,

      order,

      note: `Used ${cappedPointsUsed} points for ₹${cappedDiscountInRupees} discount on order ${order.code}`,

      type: LoyaltyTransactionType.USED_ON_ORDER,

      value: -cappedPointsUsed,

      code: `${LoyaltyTransactionType.USED_ON_ORDER}-${order.code}-${Date.now()}`,

    });

    await this.channelService.assignToCurrentChannel(transaction, ctx);

    await this.connection.getRepository(ctx, LoyaltyPointsTransaction).save(transaction);

    order.customFields.loyaltyPointsUsed = cappedPointsUsed;

    order.customFields.loyaltyPointsEarned = 0;

    await this.connection.getRepository(ctx, Order).save(order, { reload: false });

    customer.customFields.loyaltyPointsAvailable = Math.max(0, (customer.customFields.loyaltyPointsAvailable || 0) - cappedPointsUsed);

    await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

    const existingLoyaltySurcharge = order.surcharges?.find(s => s.description === 'Loyalty Points Discount');

    if (existingLoyaltySurcharge) {

      await this.orderService.removeSurchargeFromOrder(ctx, order.id, existingLoyaltySurcharge.id);

    }

    await this.orderService.addSurchargeToOrder(ctx, order.id, {

      description: 'Loyalty Points Discount',

      sku: 'LOYALTY-DISCOUNT',

      listPrice: -discountInCents,

      listPriceIncludesTax: true,

    });

    const orderWithSurcharge = await this.connection.getRepository(ctx, Order).findOneOrFail({

      where: { id: ctx.session.activeOrderId },

      relations: ['customer', 'lines', 'lines.productVariant', 'shippingLines', 'surcharges'],

    });

    if (!orderWithSurcharge) {

      throw new Error('Failed to fetch updated order');

    }

    const promotions = await this.promotionService.findAll(ctx, { filter: { enabled: { eq: true } } });

    const updatedOrder = await this.orderCalculator.applyPriceAdjustments(ctx, orderWithSurcharge, promotions.items);

    updatedOrder.customFields.loyaltyPointsUsed = cappedPointsUsed;

    updatedOrder.customFields.loyaltyPointsEarned = 0;

    await this.connection.getRepository(ctx, Order).save(updatedOrder, { reload: false });

    await this.connection.getRepository(ctx, ShippingLine).save(updatedOrder.shippingLines, { reload: false });

    Logger.info(

      `Applied ${cappedPointsUsed} points, ₹${cappedDiscountInRupees} discount to order ${order.code}. New subTotalWithTax: ₹${updatedOrder.subTotalWithTax / 100}, loyaltyPointsUsed: ${updatedOrder.customFields.loyaltyPointsUsed}, loyaltyPointsEarned: ${updatedOrder.customFields.loyaltyPointsEarned}, customer loyaltyPointsAvailable: ${customer.customFields.loyaltyPointsAvailable}`,

      loggerCtx

    );

    return updatedOrder;

  }


  async removeLoyaltyPointsFromActiveOrder(ctx: RequestContext): Promise<Order | undefined> {

    Logger.info(`Removing loyalty points from active order`, loggerCtx);

    if (!ctx.session?.activeOrderId || !ctx.activeUserId) {

      throw new UserInputError('No active order or user found');

    }

    const order = await this.connection.getEntityOrThrow(ctx, Order, ctx.session.activeOrderId, {

      channelId: ctx.channelId,

      relations: ['customer', 'lines', 'lines.productVariant', 'shippingLines', 'surcharges'],

    });

    const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);

    if (!customer || !order) {

      throw new UserInputError('No customer or order found');

    }

    const config = await this.getLoyaltyPointsConfig(ctx);

    if (!config) {

      throw new Error('No LoyaltyPointsConfig found');

    }

    const existingUsedTransaction = await this.connection.getRepository(ctx, LoyaltyPointsTransaction).findOne({

      where: { order: { id: order.id }, type: LoyaltyTransactionType.USED_ON_ORDER, channels: { id: ctx.channelId } },

    });

    if (!existingUsedTransaction) {

      Logger.info(`No loyalty points applied to order ${order.code}, no action needed`, loggerCtx);

      return order;

    }

    const pointsToRestore = Math.abs(existingUsedTransaction.value);

    await this.connection.getRepository(ctx, LoyaltyPointsTransaction).remove(existingUsedTransaction);

    customer.customFields.loyaltyPointsAvailable = (customer.customFields.loyaltyPointsAvailable || 0) + pointsToRestore;

    await this.connection.getRepository(ctx, Customer).save(customer, { reload: false });

    const existingLoyaltySurcharge = order.surcharges?.find(s => s.description === 'Loyalty Points Discount');

    if (existingLoyaltySurcharge) {

      await this.orderService.removeSurchargeFromOrder(ctx, order.id, existingLoyaltySurcharge.id);

    }

    order.customFields.loyaltyPointsUsed = 0;

    order.customFields.loyaltyPointsEarned = 0;

    await this.connection.getRepository(ctx, Order).save(order, { reload: false });

    const orderWithSurcharge = await this.connection.getRepository(ctx, Order).findOneOrFail({

      where: { id: ctx.session.activeOrderId },

      relations: ['customer', 'lines', 'lines.productVariant', 'shippingLines', 'surcharges'],

    });

    const promotions = await this.promotionService.findAll(ctx, { filter: { enabled: { eq: true } } });

    const updatedOrder = await this.orderCalculator.applyPriceAdjustments(ctx, orderWithSurcharge, promotions.items);

    updatedOrder.customFields.loyaltyPointsUsed = 0;

    updatedOrder.customFields.loyaltyPointsEarned = 0;

    await this.connection.getRepository(ctx, Order).save(updatedOrder, { reload: false });

    await this.connection.getRepository(ctx, ShippingLine).save(updatedOrder.shippingLines, { reload: false });

    Logger.info(

      `Removed ${pointsToRestore} points from order ${order.code}. Restored customer loyaltyPointsAvailable to ${customer.customFields.loyaltyPointsAvailable}, loyaltyPointsUsed: ${updatedOrder.customFields.loyaltyPointsUsed}, loyaltyPointsEarned: ${updatedOrder.customFields.loyaltyPointsEarned}, new subTotalWithTax: ₹${updatedOrder.subTotalWithTax / 100}`,

      loggerCtx

    );

    return updatedOrder;

  }


  async getPointsEarnedOnOrder(ctx: RequestContext, orderId: ID): Promise<number> {

    const transaction = await this.connection.getRepository(ctx, LoyaltyPointsTransaction).findOne({

      where: { order: { id: orderId }, type: LoyaltyTransactionType.EARNED_ON_ORDER, channels: { id: ctx.channelId } },

      order: { value: 'DESC' },

    });

    return transaction?.value ?? 0;

  }


  async createLoyaltyPointsTransaction(

    ctx: RequestContext,

    input: {

      customer: Customer;

      order?: Order;

      note: string;

      value: number;

      type: LoyaltyTransactionType;

    },

  ): Promise<LoyaltyPointsTransaction> {

    const { customer, order, note, value, type } = input;

    const transaction = new LoyaltyPointsTransaction({

      customer,

      order,

      note,

      type,

      value,

      code: order ? `${type}-${order.code}-${Date.now()}` : `ADJ-${customer.id}-${Date.now()}`,

    });

    await this.channelService.assignToCurrentChannel(transaction, ctx);

    return this.connection.getRepository(ctx, LoyaltyPointsTransaction).save(transaction);

  }


  async getLoyaltyPointsConfig(ctx: RequestContext): Promise<LoyaltyPointsConfig | null> {

    const cacheKey = loyaltyConfigKey(ctx.channelId);

    const cached = (await this.cacheService.get(cacheKey)) as LoyaltyPointsConfig | undefined;

    if (cached) {

      return cached;

    }

    const config = await this.connection

      .getRepository(ctx, LoyaltyPointsConfig)

      .findOne({

        where: { channels: { id: ctx.channelId } },

        relations: ['channels'],

      });

    if (config) {

      await this.cacheService.set(cacheKey, config as any, {

        ttl: LOYALTY_CONFIG_TTL_MS,

        tags: [LOYALTY_CONFIG_TAG_ALL, loyaltyConfigTag(ctx.channelId)],

      });

    }

    return config ?? null;

  }


  async createLoyaltyPointsConfig(ctx: RequestContext, input: { rupeesPerPoint: number, pointsPerRupee: number }): Promise<LoyaltyPointsConfig> {

    const existingConfig = await this.getLoyaltyPointsConfig(ctx);

    if (existingConfig) {

      throw new UserInputError('Loyalty points configuration already exists for this channel. Use updateLoyaltyPointsConfig instead.');

    }

    if (input.rupeesPerPoint <= 0 || input.pointsPerRupee <= 0) {

      throw new UserInputError('Rupees per point and points per rupee must be greater than zero.');

    }

    const config = new LoyaltyPointsConfig({

      rupeesPerPoint: input.rupeesPerPoint,

      pointsPerRupee: input.pointsPerRupee,

    });

    await this.channelService.assignToCurrentChannel(config, ctx);

    const saved = await this.connection.getRepository(ctx, LoyaltyPointsConfig).save(config);

    await this.invalidateLoyaltyConfigCache(ctx.channelId);

    return saved;

  }


  async updateLoyaltyPointsConfig(ctx: RequestContext, id: ID, input: { rupeesPerPoint: number, pointsPerRupee: number }): Promise<LoyaltyPointsConfig> {

    const config = await this.connection.findOneInChannel(ctx, LoyaltyPointsConfig, id, ctx.channelId, { relations: ['channels'] });

    if (!config) {

      throw new UserInputError('No LoyaltyPointsConfig found for this channel');

    }

    if (input.rupeesPerPoint <= 0 || input.pointsPerRupee <= 0) {

      throw new UserInputError('Rupees per point and points per rupee must be greater than zero.');

    }

    config.rupeesPerPoint = input.rupeesPerPoint;

    config.pointsPerRupee = input.pointsPerRupee;

    const saved = await this.connection.getRepository(ctx, LoyaltyPointsConfig).save(config);

    await this.invalidateLoyaltyConfigCache(ctx.channelId);

    return saved;

  }


  async deleteLoyaltyPointsConfig(ctx: RequestContext, id: ID): Promise<boolean> {

    const config = await this.connection.findOneInChannel(ctx, LoyaltyPointsConfig, id, ctx.channelId, { relations: ['channels'] });

    if (!config) {

      throw new UserInputError('No LoyaltyPointsConfig found for this channel');

    }

    await this.connection.getRepository(ctx, LoyaltyPointsConfig).remove(config);

    await this.invalidateLoyaltyConfigCache(ctx.channelId);

    return true;

  }


  private effectiveLoyaltyPointsUsed(order: Order, customer: Customer, amount?: number) {

    const maxDiscountable = order.lines.reduce((sum, line) => sum + line.discountedLinePriceWithTax, 0) +

      order.shippingLines.reduce((sum, sl) => sum + sl.priceWithTax, 0);

    return Math.min(

      amount ?? order.customFields.loyaltyPointsUsed ?? 0,

      maxDiscountable,

      customer.customFields.loyaltyPointsAvailable || 0,

    );

  }

}