import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, RequestContext, Transaction } from '@vendure/core';
import { DeliveryTrackingService, DriverHeartbeatInput } from '../../../services/delivery-tracking.service';
import {
    customFulfillmentPermission,
    outForDeliveryPermission,
    viewDeliveryReportsPermission,
} from '../../../permissions';

@Resolver()
export class DeliveryTrackingResolver {
    constructor(private deliveryTrackingService: DeliveryTrackingService) {}

    // ─── Driver-facing (delivery person permissions) ───

    @Mutation()
    @Transaction()
    @Allow(outForDeliveryPermission.Permission)
    async driverHeartbeat(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: DriverHeartbeatInput },
    ) {
        return this.deliveryTrackingService.heartbeat(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(outForDeliveryPermission.Permission)
    async startDeliveryRide(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderId: ID },
    ) {
        return this.deliveryTrackingService.startRide(ctx, args.orderId);
    }

    @Mutation()
    @Transaction()
    @Allow(outForDeliveryPermission.Permission)
    async completeDeliveryRide(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderId: ID; finalDistanceMeters?: number },
    ) {
        return this.deliveryTrackingService.completeRide(ctx, args.orderId, args.finalDistanceMeters);
    }

    @Query()
    @Allow(outForDeliveryPermission.Permission)
    async activeRideForMe(@Ctx() ctx: RequestContext) {
        return this.deliveryTrackingService.activeRideForMe(ctx);
    }

    // ─── Fleet-facing (admin permissions) ───

    @Query()
    @Allow(viewDeliveryReportsPermission.Permission, customFulfillmentPermission.Permission)
    async driverStatuses(@Ctx() ctx: RequestContext) {
        return this.deliveryTrackingService.driverStatuses(ctx);
    }

    @Query()
    @Allow(viewDeliveryReportsPermission.Permission, customFulfillmentPermission.Permission)
    async driverRides(
        @Ctx() ctx: RequestContext,
        @Args() args: { deliveryPersonId: ID; dateFrom: Date; dateTo: Date },
    ) {
        return this.deliveryTrackingService.driverRides(ctx, args.deliveryPersonId, args.dateFrom, args.dateTo);
    }

    @Query()
    @Allow(viewDeliveryReportsPermission.Permission, customFulfillmentPermission.Permission)
    async driverAssignedOrders(
        @Ctx() ctx: RequestContext,
        @Args() args: { deliveryPersonId: ID; dateFrom: Date; dateTo: Date },
    ) {
        return this.deliveryTrackingService.driverAssignedOrders(ctx, args.deliveryPersonId, args.dateFrom, args.dateTo);
    }

    @Query()
    @Allow(viewDeliveryReportsPermission.Permission, customFulfillmentPermission.Permission)
    fleetSocketTicket(@Ctx() ctx: RequestContext) {
        return this.deliveryTrackingService.issueSocketTicket(ctx);
    }

    @Query()
    @Allow(outForDeliveryPermission.Permission)
    driverSocketTicket(@Ctx() ctx: RequestContext) {
        return this.deliveryTrackingService.issueDriverSocketTicket(ctx);
    }
}
