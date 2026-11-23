import {
    EntityHydrator,
    Fulfillment,
    FulfillmentHandler,
    Injector,
    LanguageCode,
    Logger,
    TransactionalConnection,
} from '@vendure/core';

import { resolveVariantMeasures } from '../../../../Stock/shared/resolve-variant-measure';
import { loggerCtx } from '../constants';
import {
    AdhocMapperInput,
    buildAdhocPayload,
    sanitizePhone,
    validateAdhocInput,
} from '../mappers/order-payload.mapper';
import { ShiprocketOrderService } from '../services/shiprocket-order.service';
import { ShiprocketService } from '../services/shiprocket.service';
import { selectBox } from './pricing';

let entityHydrator: EntityHydrator;
let shiprocketService: ShiprocketService;
let shiprocketOrderService: ShiprocketOrderService;
let connection: TransactionalConnection;

/**
 * Creates the Shiprocket international order when an admin fulfils the order with this handler.
 * It builds the `create/adhoc` payload from the Vendure order + channel config, calls Shiprocket,
 * and persists the returned ids on the Fulfillment's custom fields (surfaced in the order-detail
 * dashboard block). If Shiprocket rejects the order, `createFulfillment` throws and Vendure rolls
 * the fulfillment back — so a failed Shiprocket call never leaves a dangling fulfillment.
 *
 * AWB/courier are assigned later in the Shiprocket panel; the "Sync from Shiprocket" admin action
 * (and live tracking) pick those up afterwards.
 */
export const shiprocketFulfillmentHandler = new FulfillmentHandler({
    code: 'shiprocket-international',
    description: [{ languageCode: LanguageCode.en, value: 'Shiprocket International' }],
    args: {},
    init: (injector: Injector) => {
        entityHydrator = injector.get(EntityHydrator);
        shiprocketService = injector.get(ShiprocketService);
        shiprocketOrderService = injector.get(ShiprocketOrderService);
        connection = injector.get(TransactionalConnection);
    },
    createFulfillment: async (ctx, orders, _lines, _args) => {
        const order = orders[0];
        if (!order) {
            throw new Error('No order to fulfil');
        }
        await entityHydrator.hydrate(ctx, order, {
            // `options` comes along so the measure resolver reads it in memory
            // instead of issuing its own query.
            relations: ['lines.productVariant.product', 'lines.productVariant.options', 'customer'],
        });
        const config = await shiprocketService.getConfig(ctx);

        // Weight comes from each variant's option (measureValue + measureUnit).
        const measures = await resolveVariantMeasures(
            ctx,
            connection,
            order.lines.map(l => l.productVariant).filter(Boolean),
        );

        // Build line items + total weight from the hydrated order.
        let weightGrams = 0;
        const items = order.lines.map(line => {
            const variant: any = line.productVariant;
            weightGrams += (measures.get(String(variant?.id))?.grams ?? 0) * line.quantity;
            return {
                name: variant?.name ?? variant?.sku ?? 'Item',
                sku: variant?.sku ?? '',
                units: line.quantity,
                // International orders are in USD (minor units → major units).
                sellingPrice: (line.unitPriceWithTax ?? 0) / 100,
                hsn: String(variant?.product?.customFields?.hsnCode ?? ''),
            };
        });

        const box = selectBox(config.boxBrackets, weightGrams);
        if (!box) {
            throw new Error('No box dimensions configured (Settings → Shiprocket International).');
        }

        // Shiprocket keeps cancelled orders, so every creation attempt sends a fresh RANDOM
        // numeric channel_order_id (10 digits). It is stored on the fulfillment
        // (shiprocketChannelOrderId) and shown in the admin block, keeping the Vendure link.
        const srChannelOrderId = String(Math.floor(1_000_000_000 + Math.random() * 9_000_000_000));

        const addr: any = order.shippingAddress ?? {};
        const input: AdhocMapperInput = {
            orderCode: srChannelOrderId,
            // order_date = when the customer placed the order → SR "Order created on channel".
            // SR stamps "Order created on system" itself at API-call time (= fulfillment moment).
            orderDate: order.orderPlacedAt ?? order.updatedAt ?? new Date(),
            currencyCode: order.currencyCode,
            // invoice_number = the Vendure order code, tying the SR invoice back to the order.
            invoiceNumber: order.code,
            pickupLocationName: config.pickupLocationName,
            fullName: addr.fullName ?? '',
            streetLine1: addr.streetLine1 ?? '',
            streetLine2: addr.streetLine2 ?? '',
            city: addr.city ?? '',
            // Vendure stores the checkout's "State" input in the address `province` field.
            state: addr.province ?? '',
            postalCode: addr.postalCode ?? '',
            countryName: addr.country ?? '',
            countryCode: addr.countryCode ?? '',
            email: order.customer?.emailAddress ?? '',
            phone: sanitizePhone(addr.phoneNumber ?? order.customer?.phoneNumber, addr.countryCode ?? ''),
            items,
            shippingChargesMajor: (order.shippingWithTax ?? 0) / 100,
            length: box.length,
            breadth: box.breadth,
            height: box.height,
            weightKg: Number((weightGrams / 1000).toFixed(3)),
        };

        const problems = validateAdhocInput(input);
        if (problems.length) {
            throw new Error(`Cannot create Shiprocket order:\n- ${problems.join('\n- ')}`);
        }

        const payload = buildAdhocPayload(input);
        const res = await shiprocketOrderService.createAdhocOrder(payload);
        Logger.info(
            `Created Shiprocket order ${res.order_id} (shipment ${res.shipment_id}) for ${order.code}`,
            loggerCtx,
        );

        return {
            method: `Shiprocket International${res.courier_name ? ` — ${res.courier_name}` : ''}`,
            trackingCode: res.awb_code || String(res.shipment_id ?? ''),
            customFields: {
                // Identifies this fulfillment to the delivery-strategy-router subscriber, which
                // otherwise treats untyped fulfillments as own-delivery-fleet and auto-ships them.
                fulfillmentType: 'shiprocket-international',
                shiprocketOrderId: String(res.order_id),
                shiprocketChannelOrderId: srChannelOrderId,
                shiprocketShipmentId: String(res.shipment_id ?? ''),
                shiprocketStatus: res.status ?? '',
                shiprocketAwb: res.awb_code ?? '',
                shiprocketCourierName: res.courier_name ?? '',
                shiprocketCourierId: res.courier_company_id != null ? String(res.courier_company_id) : '',
                shiprocketLength: box.length,
                shiprocketBreadth: box.breadth,
                shiprocketHeight: box.height,
                shiprocketWeightGrams: weightGrams,
                shiprocketTrackUrl: '',
                shiprocketInvoiceUrl: '',
                shiprocketLastSyncedAt: new Date(),
            },
        };
    },
    /**
     * Cancelling the Vendure fulfillment cancels the Shiprocket order too (`orders/cancel`).
     * A Shiprocket failure is logged but does NOT block the Vendure cancellation — otherwise an
     * already-cancelled/unknown SR order would leave the fulfillment stuck. Re-fulfilling after
     * a cancellation creates a fresh SR order under `<order.code>-2`, `-3`, ….
     */
    onFulfillmentTransition: async (_fromState, toState, { ctx, fulfillment }) => {
        if (toState !== 'Cancelled') {
            return;
        }
        const cf: any = fulfillment.customFields ?? {};
        const srOrderId = cf.shiprocketOrderId;
        if (!srOrderId) {
            return;
        }
        const ok = await shiprocketOrderService.cancelOrder(srOrderId);
        if (ok) {
            cf.shiprocketStatus = 'CANCELED';
            cf.shiprocketLastSyncedAt = new Date();
            await connection.getRepository(ctx, Fulfillment).save(fulfillment, { reload: false });
        } else {
            Logger.warn(
                `Vendure fulfillment ${fulfillment.id} cancelled, but Shiprocket order ${srOrderId} ` +
                    `could not be cancelled — cancel it manually in the Shiprocket panel.`,
                loggerCtx,
            );
        }
    },
});
