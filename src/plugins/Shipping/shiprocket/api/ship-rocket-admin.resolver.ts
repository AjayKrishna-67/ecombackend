// src/plugins/shiprocket/ship-rocket-admin.resolver.ts

import { Query, Resolver, Mutation, Args } from '@nestjs/graphql';
import { Permission } from '@vendure/common/lib/generated-types';
import { Allow, Ctx, Logger, RequestContext, TransactionalConnection, OrderService, FulfillmentService } from '@vendure/core';
import { ShipRocket } from '../services/ship-rocket';
import { loggerCtx } from '../constants';
import { PickupAddress, QuickRate, QuickRateParams, ShiprocketOrderDetails, QuickTrackingData } from '../types';

interface ShiprocketQuickTracking {
    shipmentId: number;
    awb: string | null;
    courierName: string | null;
    currentStatus: string | null;
    origin: string | null;
    destination: string | null;
    pickupDate: string | null;
    deliveredDate: string | null;
    etd: string | null;
    trackUrl: string | null;
    error: string | null;
    activities: Array<{
        date: string;
        status: string;
        activity: string;
        location: string;
        srStatusLabel: string | null;
    }>;
}

/** Ordered fulfillment states for auto-transition */
const FULFILLMENT_STATE_ORDER = ['Pending', 'Shipped', 'OutforDelivery', 'Delivered'];

@Resolver()
export class ShipRocketAdminResolver {
    constructor(
        private shipRocket: ShipRocket,
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private fulfillmentService: FulfillmentService,
    ) {}

    @Query()
    @Allow(Permission.SuperAdmin)
    async testShiprocketAuth(@Ctx() ctx: RequestContext): Promise<boolean> {
        try {
            Logger.info('Attempting to get Shiprocket token via GraphQL API...', loggerCtx);
            const token = await this.shipRocket.getToken();
            if (token) {
                Logger.info(`Successfully retrieved token: ${token.substring(0, 15)}...`, loggerCtx);
                return true;
            }
            Logger.error('getToken() did not return a token.', loggerCtx);
            return false;
        } catch (e: any) {
            Logger.error(`Error getting token: ${e.message}`, loggerCtx, e.stack);
            return false;
        }
    }

    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getShiprocketPickupAddresses(@Ctx() ctx: RequestContext): Promise<PickupAddress[]> {
        try {
            const addresses = await this.shipRocket.getPickupAddresses();
            Logger.info(`Retrieved ${addresses.length} pickup addresses`, loggerCtx);
            return addresses;
        } catch (error: any) {
            Logger.error(`Error fetching pickup addresses: ${error.message}`, loggerCtx, error.stack);
            return [];
        }
    }

    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getShiprocketQuickRates(
        @Ctx() ctx: RequestContext,
        @Args('input') input: QuickRateParams,
    ): Promise<QuickRate[]> {
        try {
            const quickParams: QuickRateParams = {
                ...input,
                cod: input.cod ?? 0, // Quick orders don't support COD, default to 0
                is_new_hyperlocal: input.is_new_hyperlocal ?? 1, // Required for Quick serviceability
            };
            const rates = await this.shipRocket.getQuickShippingRates(quickParams);
            Logger.info(`Retrieved ${rates.length} Quick rates`, loggerCtx);
            return rates;
        } catch (error: any) {
            Logger.error(`Error fetching Quick rates: ${error.message}`, loggerCtx, error.stack);
            return [];
        }
    }

    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getShiprocketOrderDetails(
        @Ctx() ctx: RequestContext,
        @Args('orderId') orderId: number,
    ): Promise<ShiprocketOrderDetails | null> {
        try {
            const orderDetails = await this.shipRocket.getOrderDetails(orderId);
            if (!orderDetails) {
                Logger.warn(`No order details found for order ID: ${orderId}`, loggerCtx);
            }
            return orderDetails;
        } catch (error: any) {
            Logger.error(`Error fetching order details: ${error.message}`, loggerCtx, error.stack);
            return null;
        }
    }

    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getShiprocketDetailsByVendureOrder(
        @Ctx() ctx: RequestContext,
        @Args('vendureOrderId') vendureOrderId: string,
    ): Promise<ShiprocketOrderDetails[]> {
        try {
            const order = await this.orderService.findOne(ctx, vendureOrderId, ['fulfillments']);
            if (!order?.fulfillments) {
                return [];
            }
            const results: ShiprocketOrderDetails[] = [];
            for (const fulfillment of order.fulfillments) {
                const customFields = (fulfillment as any).customFields;
                // Only Quick fulfillments — international fulfillments store their
                // own shiprocketOrderId and are handled by the intl plugin.
                if (customFields?.fulfillmentType !== 'shiprocket-quick') {
                    continue;
                }
                const shiprocketOrderId = Number(customFields?.shiprocketOrderId);
                if (!shiprocketOrderId || isNaN(shiprocketOrderId)) {
                    continue;
                }
                const details = await this.shipRocket.getOrderDetails(shiprocketOrderId);
                if (details) {
                    results.push(details);
                    // Auto-transition fulfillment based on Shiprocket status
                    await this.autoTransitionFulfillment(ctx, fulfillment, details);
                }
            }
            return results;
        } catch (error: any) {
            Logger.error(
                `Error fetching Shiprocket details for Vendure order ${vendureOrderId}: ${error.message}`,
                loggerCtx,
                error.stack,
            );
            return [];
        }
    }

    /**
     * Live tracking for a Quick shipment, keyed by shipment id (which exists
     * from order creation — the AWB only appears after a rider is assigned).
     */
    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async getShiprocketQuickTracking(
        @Ctx() ctx: RequestContext,
        @Args('shipmentId') shipmentId: number,
    ): Promise<ShiprocketQuickTracking | null> {
        try {
            const data: QuickTrackingData | null = await this.shipRocket.trackQuickShipment(shipmentId);
            if (!data) {
                return null;
            }
            const track = data.shipment_track?.[0];
            return {
                shipmentId,
                awb: track?.awb_code || null,
                courierName: track?.courier_name || null,
                currentStatus: track?.current_status || null,
                origin: track?.origin || null,
                destination: track?.destination || null,
                pickupDate: track?.pickup_date || null,
                deliveredDate: track?.delivered_date || null,
                etd: data.etd || track?.edd || null,
                trackUrl: data.track_url || null,
                error: data.error || null,
                activities: (data.shipment_track_activities ?? []).map(a => ({
                    date: a.date,
                    status: a.status,
                    activity: a.activity,
                    location: a.location,
                    srStatusLabel: (a['sr-status-label'] as string) || null,
                })),
            };
        } catch (error: any) {
            Logger.error(`Error tracking Quick shipment ${shipmentId}: ${error.message}`, loggerCtx, error.stack);
            return null;
        }
    }

    /**
     * Auto-transition fulfillment state based on Shiprocket order details.
     * - AWB + courier assigned → transition to Shipped
     * - Shiprocket status "delivered" → transition to Delivered
     */
    private async autoTransitionFulfillment(
        ctx: RequestContext,
        fulfillment: any,
        details: ShiprocketOrderDetails,
    ): Promise<void> {
        try {
            const currentState = fulfillment.state as string;
            const shipmentAwb = details.shipments?.awb;
            const shipmentCourier = details.shipments?.courier;
            const shiprocketStatus = details.status?.toLowerCase();

            // Update stored custom fields if AWB/courier data changed
            if (shipmentAwb || shipmentCourier) {
                const existingAwb = (fulfillment as any).customFields?.shiprocketAwb;
                const existingCourier = (fulfillment as any).customFields?.shiprocketCourierName;
                if (shipmentAwb !== existingAwb || shipmentCourier !== existingCourier) {
                    await this.connection.getRepository(ctx, 'Fulfillment').update(
                        { id: fulfillment.id },
                        {
                            customFields: {
                                ...(fulfillment as any).customFields,
                                shiprocketAwb: shipmentAwb || existingAwb || '',
                                shiprocketCourierName: shipmentCourier || existingCourier || '',
                                shiprocketStatus: details.status || '',
                            },
                        },
                    );
                }
            }

            // Auto → Shipped when AWB and courier are assigned and fulfillment is still Pending
            if (shipmentAwb && shipmentCourier && currentState === 'Pending') {
                Logger.info(
                    `Auto-transitioning fulfillment ${fulfillment.id} to Shipped (AWB: ${shipmentAwb}, Courier: ${shipmentCourier})`,
                    loggerCtx,
                );
                await this.transitionThroughStates(ctx, fulfillment.id, currentState, 'Shipped');
            }

            // Auto → Delivered when Shiprocket status is delivered
            if (shiprocketStatus === 'delivered' && currentState !== 'Delivered') {
                Logger.info(
                    `Auto-transitioning fulfillment ${fulfillment.id} to Delivered (Shiprocket status: delivered)`,
                    loggerCtx,
                );
                await this.transitionThroughStates(ctx, fulfillment.id, currentState, 'Delivered');
            }
        } catch (error: any) {
            Logger.error(
                `Error auto-transitioning fulfillment ${fulfillment.id}: ${error.message}`,
                loggerCtx,
                error.stack,
            );
        }
    }

    /**
     * Transition a fulfillment through intermediate states to reach the target state.
     * E.g., Pending → Shipped → OutforDelivery → Delivered
     */
    private async transitionThroughStates(
        ctx: RequestContext,
        fulfillmentId: any,
        fromState: string,
        toState: string,
    ): Promise<void> {
        const fromIndex = FULFILLMENT_STATE_ORDER.indexOf(fromState);
        const toIndex = FULFILLMENT_STATE_ORDER.indexOf(toState);
        if (fromIndex === -1 || toIndex === -1 || fromIndex >= toIndex) {
            return;
        }
        for (let i = fromIndex + 1; i <= toIndex; i++) {
            const nextState = FULFILLMENT_STATE_ORDER[i];
            try {
                await this.fulfillmentService.transitionToState(ctx, fulfillmentId, nextState as any);
                Logger.info(`Fulfillment ${fulfillmentId} transitioned to ${nextState}`, loggerCtx);
            } catch (e: any) {
                Logger.error(`Failed to transition fulfillment ${fulfillmentId} to ${nextState}: ${e.message}`, loggerCtx);
                break;
            }
        }
    }

    /**
     * Cancel Shiprocket Quick orders.
     * @param orderIds - Array of Shiprocket order IDs (not Vendure order IDs),
     *                   found in fulfillment customFields.shiprocketOrderId.
     */
    @Mutation()
    @Allow(Permission.UpdateOrder, Permission.SuperAdmin)
    async cancelShiprocketQuickOrder(
        @Ctx() ctx: RequestContext,
        @Args('orderIds') orderIds: number[],
    ): Promise<boolean> {
        try {
            Logger.info(`Cancelling Shiprocket Quick orders: ${orderIds.join(', ')}`, loggerCtx);
            const result = await this.shipRocket.cancelQuickOrder(orderIds);
            if (!result) {
                Logger.warn('Failed to cancel orders', loggerCtx);
            }
            return result;
        } catch (error: any) {
            Logger.error(`Error cancelling Quick orders: ${error.message}`, loggerCtx, error.stack);
            return false;
        }
    }

    @Mutation()
    @Allow(Permission.UpdateOrder, Permission.SuperAdmin)
    async assignShiprocketAwb(
        @Ctx() ctx: RequestContext,
        @Args('shipmentId') shipmentId: number,
        @Args('courierId') courierId: number | null,
    ): Promise<{ success: boolean; awb_code: string | null; courier_name: string | null; message: string | null }> {
        try {
            Logger.info(`Assigning AWB for shipment ID: ${shipmentId}`, loggerCtx);
            const result = await this.shipRocket.assignAwb(shipmentId, courierId ?? undefined);
            return {
                success: result?.success ?? false,
                awb_code: null,
                courier_name: null,
                message: result?.message || 'AWB assignment request sent',
            };
        } catch (error: any) {
            Logger.error(`Error assigning AWB: ${error.message}`, loggerCtx, error.stack);
            return {
                success: false,
                awb_code: null,
                courier_name: null,
                message: error.message,
            };
        }
    }
}
