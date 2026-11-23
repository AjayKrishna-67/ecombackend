import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Order, OrderService, RequestContext } from '@vendure/core';

import { deliveryPersonOf, OrderDeliveryPerson } from '../../../services/customer-delivery-person';

/**
 * `Order.deliveryPerson` on the Shop API. An Order is only reachable there
 * by its owner (activeOrder, activeCustomer.orders, orderByCode with its
 * access strategy), so the field inherits that access rule.
 */
@Resolver('Order')
export class OrderDeliveryPersonShopResolver {
    constructor(private orderService: OrderService) {}

    @ResolveField()
    async deliveryPerson(@Ctx() ctx: RequestContext, @Parent() order: Order): Promise<OrderDeliveryPerson | null> {
        // Only an order on its way can have an Adloggs rider (picked up leaves
        // it Shipped); skip the fulfillment lookup for every other order in a
        // history list.
        if (!['Shipped', 'PartiallyShipped', 'OutforDelivery', 'PartiallyDelivered'].includes(order.state as string)) {
            return null;
        }
        const fulfillments = await this.orderService.getOrderFulfillments(ctx, order);
        return deliveryPersonOf(fulfillments);
    }
}
