import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    Fulfillment,
    Logger,
    OrderService,
    Permission,
    RequestContext,
    TransactionalConnection,
} from '@vendure/core';

import { loggerCtx } from '../constants';
import { ShiprocketOrderService } from '../services/shiprocket-order.service';

@Resolver()
export class ShiprocketAdminResolver {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private shiprocketOrderService: ShiprocketOrderService,
    ) {}

    /** Stored Shiprocket data for each of an order's fulfillments (internal fields → read here). */
    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async shiprocketOrderFulfillments(@Ctx() ctx: RequestContext, @Args('orderId') orderId: string) {
        const order = await this.orderService.findOne(ctx, orderId);
        if (!order) {
            return [];
        }
        const fulfillments = await this.orderService.getOrderFulfillments(ctx, order);
        return fulfillments
            // Quick fulfillments share the shiprocket* custom fields but have their own card.
            .filter(f => {
                const cf = f.customFields as any;
                return cf?.shiprocketOrderId && cf?.fulfillmentType !== 'shiprocket-quick';
            })
            .map(f => {
                const cf = f.customFields as any;
                return {
                    fulfillmentId: f.id,
                    state: f.state ?? null,
                    shiprocketOrderId: cf.shiprocketOrderId ?? null,
                    channelOrderId: cf.shiprocketChannelOrderId ?? null,
                    shipmentId: cf.shiprocketShipmentId ?? null,
                    status: cf.shiprocketStatus ?? null,
                    awb: cf.shiprocketAwb ?? null,
                    courierName: cf.shiprocketCourierName ?? null,
                    courierId: cf.shiprocketCourierId ?? null,
                    trackUrl: cf.shiprocketTrackUrl ?? null,
                    invoiceUrl: cf.shiprocketInvoiceUrl ?? null,
                    length: cf.shiprocketLength ?? null,
                    breadth: cf.shiprocketBreadth ?? null,
                    height: cf.shiprocketHeight ?? null,
                    weightGrams: cf.shiprocketWeightGrams ?? null,
                    lastSyncedAt: cf.shiprocketLastSyncedAt
                        ? new Date(cf.shiprocketLastSyncedAt).toISOString()
                        : null,
                };
            });
    }

    /**
     * Refreshes a fulfillment from Shiprocket (`orders/show`) and writes the latest status / AWB /
     * courier / invoice link onto its custom fields. This is the manual "Sync" path — no webhook.
     */
    @Mutation()
    @Allow(Permission.UpdateOrder, Permission.SuperAdmin)
    async syncShiprocketFulfillment(
        @Ctx() ctx: RequestContext,
        @Args('fulfillmentId') fulfillmentId: string,
    ) {
        const repo = this.connection.getRepository(ctx, Fulfillment);
        const fulfillment = await repo.findOne({ where: { id: fulfillmentId } as any });
        if (!fulfillment) {
            return { success: false, message: 'Fulfillment not found', errors: [] };
        }
        const cf = fulfillment.customFields as any;
        const srOrderId = cf?.shiprocketOrderId;
        if (!srOrderId) {
            return { success: false, message: 'This fulfillment has no Shiprocket order id', errors: [] };
        }

        const details = await this.shiprocketOrderService.getOrderDetails(srOrderId);
        if (!details?.data) {
            return {
                success: false,
                message: 'Could not fetch Shiprocket order details (see server logs).',
                errors: [],
            };
        }

        const data = details.data;
        const shipment = data.shipments;
        const awb = shipment?.awb ?? cf.shiprocketAwb ?? '';
        const errors = data.errors ? Object.values(data.errors).map(String) : [];

        cf.shiprocketStatus = data.status ?? cf.shiprocketStatus ?? '';
        cf.shiprocketAwb = awb ?? '';
        cf.shiprocketCourierName = shipment?.courier ?? cf.shiprocketCourierName ?? '';
        cf.shiprocketCourierId = shipment?.courier_id != null ? String(shipment.courier_id) : cf.shiprocketCourierId ?? '';
        cf.shiprocketInvoiceUrl = shipment?.invoice_link ?? cf.shiprocketInvoiceUrl ?? '';
        if (shipment?.length != null) cf.shiprocketLength = shipment.length;
        if (shipment?.breadth != null) cf.shiprocketBreadth = shipment.breadth;
        if (shipment?.height != null) cf.shiprocketHeight = shipment.height;
        cf.shiprocketLastSyncedAt = new Date();

        await repo.save(fulfillment);
        Logger.info(`Synced Shiprocket order ${srOrderId} (status ${data.status})`, loggerCtx);

        return {
            success: true,
            message: 'Synced from Shiprocket',
            status: data.status ?? null,
            awb: awb || null,
            courierName: shipment?.courier || null,
            invoiceUrl: shipment?.invoice_link || null,
            isIncomplete: data.is_incomplete === 1,
            errors,
        };
    }

    /** Admin-side live tracking for an AWB. */
    @Query()
    @Allow(Permission.ReadOrder, Permission.SuperAdmin)
    async shiprocketTracking(@Ctx() _ctx: RequestContext, @Args('awb') awb: string) {
        return (await this.shiprocketOrderService.trackByAwb(awb)) ?? null;
    }
}
