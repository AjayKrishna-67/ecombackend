import { Injectable } from '@nestjs/common';
import {
    Fulfillment,
    FulfillmentService,
    ID,
    Logger,
    Order,
    OrderService,
    RequestContext,
    ShippingMethod,
    TransactionalConnection,
    isGraphQlErrorResult,
} from '@vendure/core';

import { resolveVariantMeasures } from '../../../Stock/shared/resolve-variant-measure';
import { ADLOGGS_FULFILLMENT_TYPE, loggerCtx } from '../constants';
import { AdloggsPickupConfig, AdloggsRiderDetails, AdloggsStatus, ADLOGGS_STATUS_LABELS } from '../types';
import { AdloggsService } from '../services/adloggs.service';
import {
    buildAdloggsCreatePayload,
    generateDeliveryOtp,
    isStaleStatus,
    nearestPickup,
    pickupConfigFromArgs,
    transitionChain,
} from '../services/adloggs-mapper';

const ADLOGGS_CALCULATOR_CODE = 'adloggs-calculator';

/** Adloggs statuses after which their cancel API would be pointless/rejected. */
const TERMINAL_STATUSES: number[] = [
    AdloggsStatus.Delivered,
    AdloggsStatus.Cancelled,
    AdloggsStatus.ReturnInitiated,
    AdloggsStatus.RtoDelivered,
];

export interface StatusUpdateInput {
    statusId: number;
    rider?: AdloggsRiderDetails;
    /** The OTP the customer gives the rider (webhook `otps.delivery_otp`). */
    deliveryOtp?: string | null;
    /**
     * 'sync' when read from getcurrentstatus: Adloggs' view right now, so its
     * rider is current even if the status it reports is older than ours (a
     * reassignment). A webhook can arrive late and out of order, so a stale
     * webhook changes nothing.
     */
    source?: 'webhook' | 'sync';
}

export interface SyncResult {
    success: boolean;
    message: string;
    statusId?: number;
    fulfillmentState?: string;
}

@Injectable()
export class AdloggsFulfillmentService {
    constructor(
        private adloggs: AdloggsService,
        private orderService: OrderService,
        private fulfillmentService: FulfillmentService,
        private connection: TransactionalConnection,
    ) {}

    /**
     * Create the Adloggs delivery order for a freshly created "adloggs"
     * fulfillment.
     *
     * Failure handling: Adloggs has been observed returning "Internal error"
     * while STILL creating the order (partial write on their side), so an error
     * here is ambiguous — we store it on `adloggsError` for the order-page card
     * and never auto-retry. Recovery paths: the admin's Sync button (which
     * retries the creation), or a webhook for this order's partner_order_id
     * (which proves the order exists and stamps the uuid — see
     * attachUuidByPartnerOrderId).
     */
    async createAdloggsOrderOnFulfillment(ctx: RequestContext, fulfillment: Fulfillment, order: Order): Promise<void> {
        const customFields = (fulfillment as any).customFields ?? {};
        if (customFields.adloggsOrderUuid) {
            Logger.info(`Fulfillment ${fulfillment.id} already has an Adloggs order, skipping`, loggerCtx);
            return;
        }

        const delivery = await this.adloggs.resolveDeliveryPoint(order.shippingAddress);
        if (!delivery) {
            await this.storeError(
                ctx,
                fulfillment.id,
                `Order ${order.code}: shipping address has no map pin and its pincode could not be located — add latitude/longitude to the address and retry`,
            );
            return;
        }
        if (delivery.approximate) {
            Logger.warn(
                `Order ${order.code}: no map pin on the address — sending Adloggs the pincode-level location (${delivery.lat}, ${delivery.long})`,
                loggerCtx,
            );
        }

        const pickup = await this.findPickupConfig(ctx, order, delivery);
        if (!pickup.config) {
            await this.storeError(ctx, fulfillment.id, pickup.error);
            return;
        }

        const measures = await resolveVariantMeasures(
            ctx,
            this.connection,
            order.lines.map(l => l.productVariant).filter(Boolean),
        );
        const totalGrams = order.lines.reduce((weight, line) => {
            const grams = measures.get(String(line.productVariant.id))?.grams || 500; // historic 500 g default
            return weight + grams * line.quantity;
        }, 0);
        const weightKg = Math.max(0.5, totalGrams / 1000);

        const deliveryOtp = generateDeliveryOtp();
        const payload = buildAdloggsCreatePayload({
            order,
            pickup: pickup.config,
            delivery,
            weightKg,
            now: new Date(),
            deliveryOtp,
        });

        Logger.info(`Creating Adloggs order for ${order.code} (${payload.payment_type})`, loggerCtx);
        const result = await this.adloggs.createOrder(payload);

        if (result.status && result.data?.order_uuid) {
            await this.updateFulfillmentCustomFields(ctx, fulfillment.id, {
                adloggsOrderUuid: result.data.order_uuid,
                adloggsTrackUrl: result.data.trackUrl || '',
                adloggsFee: result.data.fee != null ? String(result.data.fee) : '',
                adloggsStatus: AdloggsStatus.Pending,
                adloggsError: '',
                // Ours, so the customer has it even if no webhook ever
                // arrives; a webhook's otps.delivery_otp overwrites it.
                adloggsDeliveryOtp: String(deliveryOtp),
            });
            Logger.info(
                `Adloggs order created for ${order.code}: uuid=${result.data.order_uuid} fee=${result.data.fee} distance=${result.data.distance}km`,
                loggerCtx,
            );
        } else {
            const message = (result.message || 'Unknown Adloggs error').slice(0, 500);
            await this.storeError(
                ctx,
                fulfillment.id,
                `${message} — verify in the Adloggs panel before retrying (their errors can still create the order)`,
            );
        }
    }

    /**
     * Apply a status update (webhook or manual sync) to a fulfillment:
     * store the rider/status custom fields, then walk the fulfillment through
     * the implied state transitions. Order state follows automatically via
     * DeliveryFulfillmentStateSubscriber.
     */
    async applyStatusUpdate(ctx: RequestContext, fulfillmentId: ID, update: StatusUpdateInput): Promise<SyncResult> {
        const fulfillment = (await this.connection
            .getRepository(ctx, Fulfillment)
            .findOne({ where: { id: fulfillmentId } as any })) as any;
        if (!fulfillment) {
            return { success: false, message: `Fulfillment ${fulfillmentId} not found` };
        }

        const label = ADLOGGS_STATUS_LABELS[update.statusId] ?? `status ${update.statusId}`;
        const storedStatus = fulfillment.customFields?.adloggsStatus;
        if (isStaleStatus(storedStatus, update.statusId)) {
            const storedLabel = ADLOGGS_STATUS_LABELS[storedStatus] ?? `status ${storedStatus}`;
            if (update.source === 'sync') {
                const riderFields: Record<string, any> = {};
                if (update.rider?.name) riderFields.adloggsRiderName = update.rider.name;
                if (update.rider?.phone) riderFields.adloggsRiderPhone = update.rider.phone;
                if (Object.keys(riderFields).length > 0) {
                    await this.updateFulfillmentCustomFields(ctx, fulfillmentId, riderFields);
                }
            }
            Logger.info(
                `Fulfillment ${fulfillmentId}: ignoring out-of-order Adloggs status "${label}" (already ${storedLabel})`,
                loggerCtx,
            );
            return {
                success: true,
                message: `Ignored out-of-order status "${label}" — fulfillment is already ${storedLabel}`,
                statusId: storedStatus,
                fulfillmentState: fulfillment.state,
            };
        }
        const fields: Record<string, any> = { adloggsStatus: update.statusId };
        if (update.rider?.name) {
            fields.adloggsRiderName = update.rider.name;
        }
        if (update.rider?.phone) {
            fields.adloggsRiderPhone = update.rider.phone;
        }
        const deliveryOtp = String(update.deliveryOtp ?? '').trim();
        if (deliveryOtp) {
            fields.adloggsDeliveryOtp = deliveryOtp;
        }
        // Persist the status BEFORE any Cancelled transition so the
        // fulfillment-cancelled subscriber sees it and does not echo the
        // cancellation back to Adloggs.
        await this.updateFulfillmentCustomFields(ctx, fulfillmentId, fields);

        if (
            update.statusId === AdloggsStatus.ReturnInitiated ||
            update.statusId === AdloggsStatus.RtoDelivered
        ) {
            Logger.warn(
                `Adloggs reports "${label}" for fulfillment ${fulfillmentId} — goods are coming back to the store; resolve the order manually`,
                loggerCtx,
            );
        }

        let chain = transitionChain(fulfillment.state, update.statusId);
        if (chain.includes('Cancelled')) {
            // Cancelling the order already put its stock back; cancelling the
            // fulfillment as well would release the same stock a second time.
            const order = await this.getOrderForFulfillment(ctx, fulfillmentId);
            if (order?.state === 'Cancelled') {
                chain = [];
            }
        }
        let finalState = fulfillment.state as string;
        for (const state of chain) {
            const result = await this.fulfillmentService.transitionToState(ctx, fulfillmentId, state as any);
            if (isGraphQlErrorResult(result)) {
                Logger.error(
                    `Fulfillment ${fulfillmentId}: transition to "${state}" failed: ${(result as any).message}`,
                    loggerCtx,
                );
                return {
                    success: false,
                    message: `Adloggs says "${label}" but the fulfillment could not transition to ${state}`,
                    statusId: update.statusId,
                    fulfillmentState: finalState,
                };
            }
            finalState = (result as any).toState ?? state;
        }
        if (chain.length > 0) {
            Logger.info(
                `Fulfillment ${fulfillmentId} → ${finalState} (Adloggs: ${label})`,
                loggerCtx,
            );
        }
        return { success: true, message: `Adloggs status: ${label}`, statusId: update.statusId, fulfillmentState: finalState };
    }

    /**
     * Manual "Sync" from the order card. With a uuid it pulls the current
     * status; without one (creation previously failed) it retries the creation.
     */
    async syncFulfillment(ctx: RequestContext, fulfillmentId: ID): Promise<SyncResult> {
        const fulfillment = (await this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { id: fulfillmentId } as any,
        })) as any;
        if (!fulfillment) {
            return { success: false, message: `Fulfillment ${fulfillmentId} not found` };
        }
        if (fulfillment.customFields?.fulfillmentType !== ADLOGGS_FULFILLMENT_TYPE) {
            return { success: false, message: 'Not an Adloggs fulfillment' };
        }

        const uuid = fulfillment.customFields?.adloggsOrderUuid;
        if (!uuid) {
            const order = await this.getOrderForFulfillment(ctx, fulfillmentId);
            if (!order) {
                return { success: false, message: 'Could not load the order for this fulfillment' };
            }
            // Retrying creation books a real rider and costs a fee: never for
            // a fulfillment or order that is already finished.
            const finished = ['Cancelled', 'Delivered'];
            if (finished.includes(fulfillment.state) || finished.includes(order.state as string)) {
                return {
                    success: false,
                    message: `Not creating an Adloggs order: the ${
                        finished.includes(fulfillment.state) ? 'fulfillment' : 'order'
                    } is already ${finished.includes(fulfillment.state) ? fulfillment.state : order.state}`,
                };
            }
            await this.createAdloggsOrderOnFulfillment(ctx, fulfillment, order);
            const refreshed = (await this.connection.getRepository(ctx, Fulfillment).findOne({
                where: { id: fulfillmentId } as any,
            })) as any;
            const err = refreshed?.customFields?.adloggsError;
            return refreshed?.customFields?.adloggsOrderUuid
                ? { success: true, message: 'Adloggs order created', statusId: AdloggsStatus.Pending }
                : { success: false, message: err || 'Adloggs order creation failed' };
        }

        const statusResult = await this.adloggs.getCurrentStatus(uuid);
        if (!statusResult.status || !statusResult.data?.order_status_id) {
            return { success: false, message: statusResult.message || 'Could not fetch status from Adloggs' };
        }
        return this.applyStatusUpdate(ctx, fulfillmentId, {
            statusId: statusResult.data.order_status_id,
            rider: statusResult.data.deliveryStaffDetails,
            source: 'sync',
        });
    }

    /**
     * Cancel every live Adloggs order of a cancelled Vendure order.
     */
    async cancelAdloggsOrdersForOrder(ctx: RequestContext, orderId: ID, reason: string): Promise<void> {
        const fulfillments = (await this.connection
            .getRepository(ctx, Fulfillment)
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .where('ol.orderId = :orderId', { orderId })
            .getMany()) as any[];
        for (const fulfillment of fulfillments) {
            await this.cancelAdloggsForFulfillment(ctx, fulfillment, reason);
        }
    }

    /**
     * Cancel the Adloggs order behind one fulfillment (if it has one and it is
     * still cancellable). Safe to call for non-Adloggs fulfillments.
     */
    async cancelAdloggsForFulfillment(ctx: RequestContext, fulfillment: any, reason: string): Promise<void> {
        const cf = fulfillment.customFields ?? {};
        if (cf.fulfillmentType !== ADLOGGS_FULFILLMENT_TYPE || !cf.adloggsOrderUuid) {
            return;
        }
        const currentStatus = Number(cf.adloggsStatus);
        if (TERMINAL_STATUSES.includes(currentStatus)) {
            Logger.info(
                `Fulfillment ${fulfillment.id}: Adloggs order already ${ADLOGGS_STATUS_LABELS[currentStatus]}, no cancel call needed`,
                loggerCtx,
            );
            return;
        }
        const result = await this.adloggs.cancelOrder(cf.adloggsOrderUuid, reason);
        if (result.status || /already cancel/i.test(result.message ?? '')) {
            await this.updateFulfillmentCustomFields(ctx, fulfillment.id, {
                adloggsStatus: AdloggsStatus.Cancelled,
            });
            Logger.info(`Adloggs order ${cf.adloggsOrderUuid} cancelled (${reason})`, loggerCtx);
        } else {
            // "Order already picked up." etc. — rider is en route; admin must
            // coordinate with Adloggs directly.
            Logger.warn(
                `Could not cancel Adloggs order ${cf.adloggsOrderUuid}: ${result.message}`,
                loggerCtx,
            );
            // Shown on the order card: the Adloggs order may still be live
            // (e.g. "Order already picked up.") and needs sorting out with Adloggs.
            await this.updateFulfillmentCustomFields(ctx, fulfillment.id, {
                adloggsError: `Cancel refused by Adloggs: ${result.message || 'no reason given'}`.slice(0, 900),
            });
        }
    }

    /**
     * Webhook fallback: no fulfillment carries this uuid yet (creation error
     * responses on Adloggs' side can swallow the uuid), so find the order by
     * partner_order_id (= order code), pick its Adloggs fulfillment without a
     * uuid, and stamp it. Returns the fulfillment or null.
     */
    async attachUuidByPartnerOrderId(ctx: RequestContext, partnerOrderId: string, uuid: string): Promise<any | null> {
        const order = await this.orderService.findOneByCode(ctx, partnerOrderId, ['fulfillments']);
        if (!order) {
            return null;
        }
        const candidate = (order.fulfillments ?? []).find((f: any) => {
            const cf = f.customFields ?? {};
            return cf.fulfillmentType === ADLOGGS_FULFILLMENT_TYPE && !cf.adloggsOrderUuid && f.state !== 'Cancelled';
        });
        if (!candidate) {
            return null;
        }
        await this.updateFulfillmentCustomFields(ctx, candidate.id, {
            adloggsOrderUuid: uuid,
            adloggsError: '',
        });
        Logger.info(
            `Recovered Adloggs uuid ${uuid} for order ${partnerOrderId} via webhook (creation response had been lost)`,
            loggerCtx,
        );
        return candidate;
    }

    async findFulfillmentByUuid(ctx: RequestContext, uuid: string): Promise<any | null> {
        return this.connection.getRepository(ctx, Fulfillment).findOne({
            where: { customFields: { adloggsOrderUuid: uuid } } as any,
        });
    }

    async getOrderForFulfillment(ctx: RequestContext, fulfillmentId: ID): Promise<Order | undefined> {
        const row = await this.connection
            .getRepository(ctx, Fulfillment)
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .select('ol.orderId', 'orderId')
            .where('f.id = :id', { id: fulfillmentId })
            .limit(1)
            .getRawOne();
        if (!row?.orderId) {
            return undefined;
        }
        return this.orderService.findOne(ctx, row.orderId, [
            'customer',
            'lines',
            'lines.productVariant',
            'channels',
            'payments',
            'shippingLines',
            'shippingLines.shippingMethod',
        ]);
    }

    /**
     * The pickup (store) details for this order, read from the Adloggs
     * calculator's arguments on a shipping method:
     *
     * 1. The order's own shipping line, when the customer checked out with the
     *    Adloggs method (same read-back pattern as Shiprocket Quick).
     * 2. Otherwise an Adloggs shipping method assigned to one of the order's
     *    channels — the store NEAREST the customer's map pin when there are
     *    several — so the admin can dispatch ANY order via Adloggs even while
     *    its checkout quoting is unavailable.
     */
    private async findPickupConfig(
        ctx: RequestContext,
        order: Order,
        delivery: { lat: number; long: number },
    ): Promise<{ config: AdloggsPickupConfig | null; error: string }> {
        for (const line of order.shippingLines ?? []) {
            const calculator = (line.shippingMethod as any)?.calculator;
            if (calculator?.code === ADLOGGS_CALCULATOR_CODE) {
                const { config, missing } = pickupConfigFromArgs(calculator.args);
                return config
                    ? { config, error: '' }
                    : {
                          config: null,
                          error: `Adloggs shipping method "${(line.shippingMethod as any)?.code}" is missing calculator arguments: ${missing.join(', ')}`,
                      };
            }
        }

        let channelIds = ((order as any).channels ?? []).map((c: any) => String(c.id));
        if (!channelIds.length) {
            const loaded = await this.orderService.findOne(ctx, order.id, ['channels']);
            channelIds = ((loaded as any)?.channels ?? []).map((c: any) => String(c.id));
        }
        const methods = (await this.connection.getRepository(ctx, ShippingMethod).find({
            relations: ['channels'],
        })) as any[];
        const candidates = methods.filter(
            m =>
                !m.deletedAt &&
                m.calculator?.code === ADLOGGS_CALCULATOR_CODE &&
                (m.channels ?? []).some((c: any) => channelIds.includes(String(c.id))),
        );
        const complete = candidates
            .map(method => ({ method, config: pickupConfigFromArgs(method.calculator.args).config }))
            .filter((c): c is { method: any; config: AdloggsPickupConfig } => !!c.config);
        const chosen = nearestPickup(complete, delivery.lat, delivery.long);
        if (chosen) {
            if (complete.length > 1) {
                Logger.info(
                    `Order ${order.code}: ${complete.length} Adloggs stores on its channel — using nearest "${chosen.method.code}"`,
                    loggerCtx,
                );
            }
            return { config: chosen.config, error: '' };
        }
        return {
            config: null,
            error:
                candidates.length > 0
                    ? `Adloggs shipping method "${candidates[0].code}" is missing calculator arguments`
                    : `No shipping method with the Adloggs calculator is assigned to this order's channel — create one and fill its pickup arguments`,
        };
    }

    private async storeError(ctx: RequestContext, fulfillmentId: ID, message: string): Promise<void> {
        Logger.error(message, loggerCtx);
        await this.updateFulfillmentCustomFields(ctx, fulfillmentId, {
            adloggsError: message.slice(0, 900),
        });
    }

    private async updateFulfillmentCustomFields(
        ctx: RequestContext,
        fulfillmentId: ID,
        fields: Record<string, any>,
    ): Promise<void> {
        await this.connection.getRepository(ctx, Fulfillment).update({ id: fulfillmentId } as any, {
            customFields: fields,
        } as any);
    }
}
