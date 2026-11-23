import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    AdministratorEvent,
    CacheService,
    EventBus,
    FulfillmentStateTransitionEvent,
    ID,
    isGraphQlErrorResult,
    ListQueryBuilder,
    Order,
    OrderService,
    OrderStateTransitionEvent,
    RequestContext,
    SortOrder,
    TransactionalConnection,
} from '@vendure/core';

/** TTL constants. DP list rarely changes; order list refreshes briskly. */
const DP_CACHE_TTL_MS = 5 * 60 * 1000;
const ORDERS_CACHE_TTL_MS = 30 * 1000;
const MY_FULFILLMENTS_CACHE_TTL_MS = 30 * 1000;

/**
 * Hard cap on the fulfillments-by-driver query. Without it the query returns
 * every fulfillment a driver has ever handled, and each innerJoinAndSelect on
 * orderLine hydrates the `customFieldsAddonselections` longtext — heap grows
 * unbounded as history accumulates. Ordered by createdAt DESC, so this keeps
 * the most recent slice, which is all the delivery UI shows.
 */
const MAX_DELIVERY_FULFILLMENTS = 200;

/**
 * Fulfillment states that make an order "assigned and in the delivery pipeline"
 * for the logged-in delivery person. Pending = not yet shipped (nothing to do);
 * Cancelled = aborted.
 *
 * ACTIVE states are always returned (there's work to do). DELIVERED is terminal:
 * it's returned only inside the `deliveredSince` window so the rider's list isn't
 * flooded with historical deliveries. Splitting them lets the SQL apply the window
 * to Delivered rows alone.
 */
const MY_DELIVERY_ACTIVE_FULFILLMENT_STATES = ['Shipped', 'OutforDelivery'];
const MY_DELIVERY_DELIVERED_STATE = 'Delivered';

/** Cache tag prefixes — used for bulk invalidation via invalidateTags(). */
const TAG_DP_LIST = 'delivery-partner:dp-list';
const TAG_DELIVERY_ORDERS_PREFIX = 'delivery-partner:orders:channel:';
const TAG_MY_FULFILLMENTS_PREFIX = 'delivery-partner:my-fulfillments:dp:';

@Injectable()
export class DeliveryPartnerService implements OnApplicationBootstrap {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private listQueryBuilder: ListQueryBuilder,
        private cacheService: CacheService,
        private eventBus: EventBus,
    ) {}

    /**
     * Wire cache invalidation to domain events. Mutations that go through the
     * standard Vendure flow (createFulfillment, transition state, etc.) fire
     * these events automatically, so resolvers don't need to invalidate manually.
     */
    onApplicationBootstrap() {
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(event => {
            const channelId = event.ctx.channelId;
            this.cacheService
                .invalidateTags([`${TAG_DELIVERY_ORDERS_PREFIX}${channelId}`])
                .catch(() => { /* non-fatal */ });
        });
        this.eventBus.ofType(FulfillmentStateTransitionEvent).subscribe(event => {
            const channelId = event.ctx.channelId;
            const dpId = (event.fulfillment as any).customFields?.deliveryPersonId;
            const tags: string[] = [`${TAG_DELIVERY_ORDERS_PREFIX}${channelId}`];
            if (dpId) {
                tags.push(`${TAG_MY_FULFILLMENTS_PREFIX}${dpId}`);
            }
            this.cacheService.invalidateTags(tags).catch(() => { /* non-fatal */ });
        });
        this.eventBus.ofType(AdministratorEvent).subscribe(() => {
            this.cacheService.invalidateTags([TAG_DP_LIST]).catch(() => { /* non-fatal */ });
        });
    }

    // ─── Delivery Person Lookup ───

    private buildDeliveryPersonQuery(ctx: RequestContext) {
        return this.connection
            .getRepository(ctx, 'Administrator')
            .createQueryBuilder('admin')
            .leftJoinAndSelect('admin.user', 'user')
            .leftJoinAndSelect('user.roles', 'role')
            .innerJoin('role.channels', 'channel')
            .where('admin.deletedAt IS NULL')
            .andWhere('channel.id = :channelId', { channelId: ctx.channelId })
            .andWhere('FIND_IN_SET(:perm1, role.permissions) > 0', { perm1: 'TransitionToOutForDelivery' })
            .andWhere('FIND_IN_SET(:perm2, role.permissions) > 0', { perm2: 'TransitionToDelivered' })
            .andWhere('role.code != :superAdminCode', { superAdminCode: '__super_admin_role__' });
    }

    private mapToDeliveryPerson(admin: any) {
        return {
            id: admin.id,
            firstName: admin.firstName,
            lastName: admin.lastName,
            emailAddress: admin.emailAddress,
            phoneNumber: admin.customFields?.phoneNumber || null,
            user: admin.user,
        };
    }

    /**
     * Get all administrators with delivery-person permissions for the channel.
     * Cached by channel; invalidated on any AdministratorEvent.
     */
    async getDeliveryPersons(ctx: RequestContext) {
        const cacheKey = `delivery-partner:dps:channel:${ctx.channelId}`;
        const cached = await (this.cacheService.get as any)(cacheKey) as any[] | undefined;
        if (cached) {
            return cached;
        }
        const deliveryPersons = await this.buildDeliveryPersonQuery(ctx).getMany();
        const result = deliveryPersons.map((admin: any) => this.mapToDeliveryPerson(admin));
        await this.cacheService.set(cacheKey, result, {
            ttl: DP_CACHE_TTL_MS,
            tags: [TAG_DP_LIST],
        });
        return result;
    }

    async getDeliveryPerson(ctx: RequestContext, id: ID) {
        const admin = await this.buildDeliveryPersonQuery(ctx)
            .andWhere('admin.id = :id', { id })
            .getOne();
        return admin ? this.mapToDeliveryPerson(admin) : null;
    }

    async getAdministratorIdFromUser(ctx: RequestContext): Promise<ID | null> {
        if (!ctx.activeUserId) {
            return null;
        }
        const row = await this.connection
            .getRepository(ctx, 'Administrator')
            .createQueryBuilder('admin')
            .innerJoin('admin.user', 'user')
            .select('admin.id', 'adminId')
            .where('user.id = :userId', { userId: ctx.activeUserId })
            .andWhere('admin.deletedAt IS NULL')
            .getRawOne();
        return row?.adminId || null;
    }

    async getMyDeliveryProfile(ctx: RequestContext) {
        if (!ctx.activeUserId) {
            return null;
        }
        const admin = await this.buildDeliveryPersonQuery(ctx)
            .andWhere('user.id = :userId', { userId: ctx.activeUserId })
            .getOne();
        if (!admin) {
            return null;
        }
        const dp = this.mapToDeliveryPerson(admin);
        delete dp.user;
        return dp;
    }

    // ─── Fulfillment Queries ───

    /**
     * Get fulfillments for the logged-in DP. Cached per (DP × channel);
     * invalidated when a fulfillment for this DP changes state.
     */
    async getMyDeliveryFulfillments(ctx: RequestContext) {
        const adminId = await this.getAdministratorIdFromUser(ctx);
        if (!adminId) {
            return [];
        }
        const cacheKey = `delivery-partner:my-fulfillments:dp:${adminId}:channel:${ctx.channelId}`;
        // Same rationale as getDeliveryOrders: cache only IDs to avoid
        // entity-getter serialization issues; re-hydrate by PK on hit.
        const cached = await (this.cacheService.get as any)(cacheKey) as
            | Array<string | number>
            | undefined;
        if (cached) {
            return cached.length === 0 ? [] : await this.fetchFulfillmentsByIds(ctx, cached);
        }
        const result = await this.getFulfillmentsByDeliveryPerson(ctx, adminId);
        const ids = (result as any[]).map(f => f.id);
        await this.cacheService.set(cacheKey, ids, {
            ttl: MY_FULFILLMENTS_CACHE_TTL_MS,
            tags: [`${TAG_MY_FULFILLMENTS_PREFIX}${adminId}`],
        });
        return result;
    }

    /**
     * Get all fulfillments assigned to a specific delivery person.
     * Channel-scoped via inner join on order.channels to prevent the GraphQL
     * non-nullable `OrderLine.order` violation when an order belongs to a
     * different channel.
     */
    async getFulfillmentsByDeliveryPerson(ctx: RequestContext, deliveryPersonId: ID) {
        return this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('fulfillment')
            .innerJoinAndSelect('fulfillment.lines', 'fulfillmentLine')
            .innerJoinAndSelect('fulfillmentLine.orderLine', 'orderLine')
            .innerJoinAndSelect('orderLine.order', 'order')
            .innerJoin('order.channels', 'orderChannel', 'orderChannel.id = :channelId', { channelId: ctx.channelId })
            .where('fulfillment.customFieldsDeliverypersonid = :deliveryPersonId', { deliveryPersonId })
            .orderBy('fulfillment.createdAt', 'DESC')
            .take(MAX_DELIVERY_FULFILLMENTS)
            .getMany();
    }

    /**
     * Re-hydrate fulfillments by primary key for the cache-hit path. Same
     * relation graph as getFulfillmentsByDeliveryPerson but the WHERE is just
     * an IN-clause on the PK, so no scan or filter cost.
     */
    private async fetchFulfillmentsByIds(ctx: RequestContext, ids: Array<string | number>): Promise<any[]> {
        if (ids.length === 0) return [];
        return this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('fulfillment')
            .innerJoinAndSelect('fulfillment.lines', 'fulfillmentLine')
            .innerJoinAndSelect('fulfillmentLine.orderLine', 'orderLine')
            .innerJoinAndSelect('orderLine.order', 'order')
            .where('fulfillment.id IN (:...ids)', { ids })
            .orderBy('fulfillment.createdAt', 'DESC')
            .getMany();
    }

    /**
     * Get fulfillments + payment info for the logged-in DP.
     * NOT cached: payment state is sensitive to QR-code polling and must
     * always reflect the latest server-side state.
     */
    async getMyDeliveryFulfillmentsWithPayment(ctx: RequestContext) {
        const adminId = await this.getAdministratorIdFromUser(ctx);
        if (!adminId) {
            return [];
        }
        const fulfillments = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('fulfillment')
            .innerJoinAndSelect('fulfillment.lines', 'fulfillmentLine')
            .innerJoinAndSelect('fulfillmentLine.orderLine', 'orderLine')
            .innerJoinAndSelect('orderLine.order', 'order')
            .innerJoin('order.channels', 'orderChannel', 'orderChannel.id = :channelId', { channelId: ctx.channelId })
            .leftJoinAndSelect('order.payments', 'payment')
            .leftJoinAndSelect('order.customer', 'customer')
            .where('fulfillment.customFieldsDeliverypersonid = :dpId', { dpId: adminId })
            .andWhere('fulfillment.state IN (:...states)', {
                states: ['Shipped', 'OutforDelivery', 'Delivered'],
            })
            .orderBy('fulfillment.createdAt', 'DESC')
            .take(MAX_DELIVERY_FULFILLMENTS)
            .getMany();
        return fulfillments.map((f: any) => {
            const order = f.lines?.[0]?.orderLine?.order;
            const paymentMethod = order?.payments?.[0]?.method || 'unknown';
            return {
                id: f.id,
                state: f.state,
                trackingCode: f.trackingCode,
                method: f.method,
                createdAt: f.createdAt,
                updatedAt: f.updatedAt,
                lines: f.lines,
                orderCode: order?.code || '',
                orderTotal: order ? (order.subTotalWithTax || 0) + (order.shippingWithTax || 0) : 0,
                paymentMethod,
                paymentCollectionMethod: f.customFields?.paymentCollectionMethod || null,
                collectedAmount: f.customFields?.collectedAmount || null,
                collectionNote: f.customFields?.collectionNote || null,
                customerName: order?.customer
                    ? `${order.customer.firstName} ${order.customer.lastName}`
                    : null,
                shippingAddress: order?.shippingAddress
                    ? JSON.stringify(order.shippingAddress)
                    : null,
            };
        });
    }

    // ─── Delivery Orders (Order Assigner) ───

    /**
     * Get orders filtered by shipping method and/or postal code.
     * Cached per (channel × options) for ORDERS_CACHE_TTL_MS; invalidated when
     * any order in the channel transitions state, when a fulfillment state
     * changes, or after the TTL elapses.
     */
    async getDeliveryOrders(ctx: RequestContext, options: {
        shippingMethodId?: ID;
        postalCode?: string;
        area?: string;
        skip?: number;
        take?: number;
        filter?: any;
        sort?: any;
        filterOperator?: any;
    }) {
        const channelId = ctx.channelId;
        const cacheKey = this.buildOrdersCacheKey(channelId, options);
        // Cache only IDs + totalItems. Vendure's cache strategy serializes via
        // class-transformer which invokes Order entity getters (e.g. `discounts`)
        // that require relations we don't load, so caching the entity itself
        // throws during serialization. Re-fetching by PK on cache hit is sub-50ms.
        const cached = await (this.cacheService.get as any)(cacheKey) as
            | { ids: Array<string | number>; totalItems: number }
            | undefined;
        if (cached) {
            const items = cached.ids.length === 0
                ? []
                : await this.fetchOrdersByIds(ctx, cached.ids);
            return { items, totalItems: cached.totalItems };
        }
        const { shippingMethodId, postalCode, area, ...listOptions } = options;
        // Only load relations needed for the list view (code, customer name,
        // state, total, invoice number, payment method). The old query loaded
        // lines + productVariant + fulfillments which are NOT displayed in the
        // list — those extra JOINs on 18K+ orders caused ~3s load times.
        const qb = this.listQueryBuilder
            .build(Order, listOptions, {
                ctx,
                relations: [
                    'customer',
                    'payments',
                ],
                channelId: ctx.channelId,
                customPropertyMap: {
                    customerLastName: 'customer.lastName',
                    transactionId: 'payments.transactionId',
                },
            })
            .leftJoinAndSelect('order.shippingLines', 'sl')
            .leftJoin('sl.shippingMethod', 'sm')
            .andWhere('order.state IN (:...states)', { states: ['PaymentAuthorized', 'PaymentSettled'] });
        if (shippingMethodId) {
            qb.andWhere('sl.shippingMethodId = :shippingMethodId', { shippingMethodId });
        }
        if (postalCode) {
            qb.andWhere('order.shippingAddress LIKE :postalCode', {
                postalCode: `%"postalCode":"${postalCode}"%`,
            });
        }
        if (area) {
            qb.andWhere('order.shippingAddress LIKE :area', {
                area: `%"area":"${area}"%`,
            });
        }
        const [items, totalItems] = await qb.getManyAndCount();
        const result = { items, totalItems };
        const ids = items.map(o => o.id);
        await this.cacheService.set(cacheKey, { ids, totalItems }, {
            ttl: ORDERS_CACHE_TTL_MS,
            tags: [`${TAG_DELIVERY_ORDERS_PREFIX}${channelId}`],
        });
        return result;
    }

    /**
     * Order-centric list of the orders assigned to the logged-in delivery person.
     *
     * Replaces the fulfillment-centric `myDeliveryFulfillments` for the PWA orders
     * list: returns distinct Orders (not fulfillment lines), server-side paginated
     * with a real total, so the client no longer duplicates the order per line or
     * re-groups fulfillments into orders.
     *
     * Scope is enforced by an EXISTS subquery on the order↔fulfillment junction:
     * an order is included only if it has a fulfillment assigned to this DP
     * (customFieldsDeliverypersonid) in an active delivery state. EXISTS avoids the
     * row multiplication a JOIN to the fulfillments collection would cause, so
     * getManyAndCount pages and counts correctly without DISTINCT gymnastics.
     */
    async getMyDeliveryOrders(ctx: RequestContext, options: {
        shippingMethodId?: ID;
        postalCode?: string;
        area?: string;
        search?: string;
        skip?: number;
        take?: number;
        filter?: any;
        sort?: any;
        filterOperator?: any;
        deliveredSince?: Date | string;
    }) {
        const adminId = await this.getAdministratorIdFromUser(ctx);
        if (!adminId) {
            return { items: [], totalItems: 0 };
        }
        const { shippingMethodId, postalCode, area, search, deliveredSince, ...rest } = options;
        // A list endpoint owns its default order — newest first — so no caller can
        // forget it and refetch the oldest 200 rows. Caller sort still wins if given.
        const listOptions = { ...rest, sort: rest.sort ?? { updatedAt: 'DESC' as SortOrder } };
        const qb = this.listQueryBuilder
            .build(Order, listOptions, {
                ctx,
                relations: ['customer', 'payments'],
                channelId: ctx.channelId,
                customPropertyMap: {
                    customerLastName: 'customer.lastName',
                    transactionId: 'payments.transactionId',
                },
            })
            .leftJoinAndSelect('order.shippingLines', 'sl')
            .leftJoin('sl.shippingMethod', 'sm')
            .andWhere(
                'EXISTS (' +
                'SELECT 1 FROM `order_fulfillments_fulfillment` off ' +
                'INNER JOIN `fulfillment` f ON f.id = off.fulfillmentId ' +
                'WHERE off.orderId = order.id ' +
                'AND f.customFieldsDeliverypersonid = :dpId ' +
                'AND (' +
                'f.state IN (:...activeStates)' +
                // Delivered rows join only when inside the window (or always, if no
                // window supplied). Filtering here — in SQL — means long-delivered
                // orders are never fetched, not fetched-then-hidden on the client.
                (deliveredSince
                    ? ' OR (f.state = :deliveredState AND f.updatedAt >= :deliveredSince)'
                    : ' OR f.state = :deliveredState') +
                ')' +
                ')',
                {
                    dpId: adminId,
                    activeStates: MY_DELIVERY_ACTIVE_FULFILLMENT_STATES,
                    deliveredState: MY_DELIVERY_DELIVERED_STATE,
                    ...(deliveredSince ? { deliveredSince } : {}),
                },
            );
        if (shippingMethodId) {
            qb.andWhere('sl.shippingMethodId = :shippingMethodId', { shippingMethodId });
        }
        if (postalCode) {
            qb.andWhere('order.shippingAddress LIKE :postalCode', {
                postalCode: `%"postalCode":"${postalCode}"%`,
            });
        }
        if (area) {
            qb.andWhere('order.shippingAddress LIKE :area', {
                area: `%"area":"${area}"%`,
            });
        }
        if (search) {
            // Free-text over order code + customer name. Runs in SQL so it filters
            // the whole scoped set before paging — a client filter would only see
            // the current page and disagree with totalItems.
            qb.andWhere(
                '(order.code LIKE :search OR customer.firstName LIKE :search OR customer.lastName LIKE :search)',
                { search: `%${search}%` },
            );
        }
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    /**
     * Re-hydrate Orders by primary key. Used on cache hit: the heavy
     * filter/sort/count is skipped (cache served those), and we just need
     * the entities back with the same relations the original query loaded.
     * IN (...) on the primary key is index-backed and very fast.
     *
     * Preserves the input order (cache stored IDs in the original sort order).
     */
    private async fetchOrdersByIds(ctx: RequestContext, ids: Array<string | number>): Promise<Order[]> {
        if (ids.length === 0) return [];
        const fresh = await this.connection
            .getRepository(ctx, Order)
            .createQueryBuilder('order')
            .leftJoinAndSelect('order.customer', 'customer')
            .leftJoinAndSelect('order.payments', 'payments')
            .leftJoinAndSelect('order.shippingLines', 'sl')
            .leftJoin('sl.shippingMethod', 'sm')
            .where('order.id IN (:...ids)', { ids })
            .getMany();
        const byId = new Map<string, Order>();
        for (const o of fresh) {
            byId.set(String(o.id), o);
        }
        const ordered: Order[] = [];
        for (const id of ids) {
            const found = byId.get(String(id));
            if (found) ordered.push(found);
        }
        return ordered;
    }

    /**
     * Stable cache key for the delivery-orders query. Explicit field picking
     * insulates against caller-side property reordering and keeps the key
     * short enough for Redis.
     */
    private buildOrdersCacheKey(channelId: ID, options: {
        shippingMethodId?: ID;
        postalCode?: string;
        area?: string;
        skip?: number;
        take?: number;
        filter?: any;
        sort?: any;
        filterOperator?: any;
    }): string {
        const stable = JSON.stringify({
            s: options.shippingMethodId ?? null,
            p: options.postalCode ?? null,
            a: options.area ?? null,
            sk: options.skip ?? 0,
            t: options.take ?? 25,
            f: options.filter ?? null,
            so: options.sort ?? null,
            fo: options.filterOperator ?? null,
        });
        return `delivery-partner:orders:channel:${channelId}:${stable}`;
    }

    /**
     * Get delivery assignment info for all fulfillments of an order.
     */
    async getOrderDeliveryAssignments(ctx: RequestContext, orderId: ID) {
        const fulfillments = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('fulfillment')
            .leftJoin('fulfillment.lines', 'fulfillmentLine')
            .leftJoin('fulfillmentLine.orderLine', 'orderLine')
            .leftJoin('orderLine.order', 'order')
            .where('order.id = :orderId', { orderId })
            .andWhere('fulfillment.customFieldsDeliverypersonname IS NOT NULL')
            .andWhere("fulfillment.customFieldsDeliverypersonname != ''")
            .orderBy('fulfillment.createdAt', 'DESC')
            .getMany();
        return fulfillments.map((f: any) => ({
            fulfillmentId: f.id,
            state: f.state,
            deliveryPersonName: f.customFields?.deliveryPersonName || '',
            deliveryPersonPhone: f.customFields?.deliveryPersonPhone || '',
            createdAt: f.createdAt,
        }));
    }

    // ─── Fulfillment Creation ───

    /**
     * Create a fulfillment with delivery person assignment using the kaaikani-fulfillment handler.
     * No manual cache invalidation: createFulfillment fires FulfillmentStateTransitionEvent
     * (initial Pending state) and OrderStateTransitionEvent, which our event subscribers
     * use to flush the relevant cache tags.
     */
    async createDeliveryFulfillment(ctx: RequestContext, input: {
        lines: Array<{ orderLineId: ID; quantity: number }>;
        deliveryPersonId: ID;
    }) {
        const fulfillmentConfig = JSON.stringify({
            type: 'own-delivery-fleet',
            deliveryPersonId: String(input.deliveryPersonId),
        });
        const result = await this.orderService.createFulfillment(ctx, {
            lines: input.lines,
            handler: {
                code: 'kaaikani-fulfillment',
                arguments: [{ name: 'fulfillmentConfig', value: fulfillmentConfig }],
            },
        });
        if (isGraphQlErrorResult(result)) {
            throw new Error((result as any).message || 'Failed to create fulfillment');
        }
        return result;
    }
}
