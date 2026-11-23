import { Args, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ForbiddenError, LogLevel, Permission, RequestContext } from '@vendure/core';

import { DeliveryTrackingService } from '../../../services/delivery-tracking.service';

/**
 * Shop-API surface of live delivery tracking — one query, owner-only.
 *
 * Mirrors core's `orderByCode`: `Permission.Owner` admits any shop session,
 * `authorizedAsOwnerOnly` confirms it IS a shop session (not an admin token
 * pointed at the shop API), and the actual "is this your order?" decision is
 * Vendure's OrderByCodeAccessStrategy inside the service.
 */
@Resolver()
export class DeliveryTrackingShopResolver {
    constructor(private deliveryTrackingService: DeliveryTrackingService) {}

    @Query()
    @Allow(Permission.Owner)
    async orderDeliveryTracking(@Ctx() ctx: RequestContext, @Args() args: { orderCode: string }) {
        if (!ctx.authorizedAsOwnerOnly) {
            throw new ForbiddenError(LogLevel.Verbose);
        }
        return this.deliveryTrackingService.customerTracking(ctx, args.orderCode);
    }
}
