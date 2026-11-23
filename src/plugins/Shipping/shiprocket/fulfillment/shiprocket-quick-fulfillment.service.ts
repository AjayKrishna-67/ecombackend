import { Injectable } from '@nestjs/common';
import {
    Fulfillment,
    Order,
    OrderService,
    RequestContext,
    Logger,
    TransactionalConnection,
} from '@vendure/core';
import { resolveVariantMeasures } from '../../../Stock/shared/resolve-variant-measure';
import { ShipRocket } from '../services/ship-rocket';
import { loggerCtx } from '../constants';
import { CreateQuickOrderInput } from '../types';
import { resolveBillingState } from './resolve-billing-state';

@Injectable()
export class ShiprocketQuickFulfillmentService {
    constructor(
        private shipRocket: ShipRocket,
        private orderService: OrderService,
        private connection: TransactionalConnection,
    ) {}

    /**
     * Create Shiprocket Quick order when fulfillment is created
     */
    async createQuickOrderOnFulfillment(ctx: RequestContext, fulfillment: Fulfillment, order: Order): Promise<void> {
        try {
            // Load order with shipping method and product relations to check calculator and get category
            const orderWithShipping = await this.orderService.findOne(ctx, order.id, [
                'shippingLines',
                'shippingLines.shippingMethod',
                'lines',
                'lines.productVariant',
                'lines.productVariant.product',
                'lines.productVariant.product.facetValues',
                'lines.productVariant.product.facetValues.facet',
            ]);

            if (!orderWithShipping?.shippingLines || orderWithShipping.shippingLines.length === 0) {
                Logger.warn(`Order ${order.code} has no shipping lines, skipping Quick order creation`, loggerCtx);
                return;
            }

            // Find the Quick shipping line and get calculator args
            const quickShippingLine = orderWithShipping.shippingLines.find(line => {
                const calculator = (line.shippingMethod as any)?.calculator;
                return calculator?.code === 'shiprocket-quick-calculator';
            });

            if (!quickShippingLine) {
                Logger.info(`Fulfillment ${fulfillment.id} is not for a Shiprocket Quick order, skipping`, loggerCtx);
                return;
            }

            // Get calculator args from the shipping method.
            // Vendure stores calculator args as an array of { name, value } objects.
            const shippingMethod = quickShippingLine.shippingMethod as any;
            const calculator = shippingMethod?.calculator;

            let priorityPincodes: string[] | undefined;

            if (calculator?.args) {
                const rawArgs = typeof calculator.args === 'string' ? JSON.parse(calculator.args) : calculator.args;
                if (Array.isArray(rawArgs)) {
                    const priorityPincodesArg = rawArgs.find((a: any) => a.name === 'priorityPincodes');
                    const priorityPincodesStr = priorityPincodesArg?.value;
                    priorityPincodes = priorityPincodesStr
                        ? String(priorityPincodesStr).split(',').map(p => p.trim()).filter(p => p.length > 0)
                        : undefined;
                } else {
                    const priorityPincodesStr = rawArgs.priorityPincodes;
                    priorityPincodes = priorityPincodesStr
                        ? String(priorityPincodesStr).split(',').map(p => p.trim()).filter(p => p.length > 0)
                        : undefined;
                }
            }

            // Use default channel ID from environment variable
            const finalChannelId = process.env.SHIPROCKET_CHANNEL_ID ? parseInt(process.env.SHIPROCKET_CHANNEL_ID) : undefined;

            const shippingAddress = order.shippingAddress;
            if (!shippingAddress) {
                Logger.error(`Order ${order.code} has no shipping address`, loggerCtx);
                return;
            }

            // Get delivery coordinates
            const addressCustomFields = shippingAddress.customFields as any;
            const deliveryLat = addressCustomFields?.latitude;
            const deliveryLong = addressCustomFields?.longitude;

            if (!deliveryLat || !deliveryLong) {
                Logger.error(`Order ${order.code} shipping address missing latitude/longitude`, loggerCtx);
                return;
            }

            // Find nearest pickup address (pass pincode, city, and priority pincodes for priority matching)
            const nearestPickup = await this.shipRocket.findNearestPickupAddress(
                deliveryLat,
                deliveryLong,
                shippingAddress.postalCode,
                shippingAddress.city,
                priorityPincodes,
            );

            if (!nearestPickup) {
                Logger.error(`No active pickup address found for order ${order.code}`, loggerCtx);
                return;
            }

            const pickupLocation = nearestPickup.pickup_location;

            const pickupLat = parseFloat(nearestPickup.lat);
            const pickupLong = parseFloat(nearestPickup.long);

            if (isNaN(pickupLat) || isNaN(pickupLong)) {
                Logger.error(`Invalid pickup coordinates: lat=${nearestPickup.lat}, long=${nearestPickup.long}`, loggerCtx);
                return;
            }

            // Use shipping address for billing (since shipping_is_billing: true)
            if (!shippingAddress.streetLine1 || !shippingAddress.city || !shippingAddress.postalCode) {
                Logger.error(
                    `Order ${order.code} shipping address missing required fields: streetLine1=${shippingAddress.streetLine1}, city=${shippingAddress.city}, postalCode=${shippingAddress.postalCode}`,
                    loggerCtx,
                );
                return;
            }

            // Shiprocket requires billing_state; KaaiKani addresses rarely carry
            // a province, so fall back to the pickup warehouse's state (Quick is
            // hyperlocal — pickup and delivery share a city).
            const billingState = resolveBillingState(shippingAddress.province, nearestPickup.state);
            if (!billingState) {
                Logger.error(
                    `Order ${order.code} has no province and pickup location ${pickupLocation} has no state — cannot set billing_state`,
                    loggerCtx,
                );
                return;
            }
            if (billingState.fromPickup) {
                Logger.info(
                    `Order ${order.code} has no province; using pickup state "${billingState.state}" for billing_state`,
                    loggerCtx,
                );
            }

            // Calculate dimensions and weight
            const orderLines = orderWithShipping?.lines || order.lines;
            // Weight from each variant's option, with the historic 500 g
            // default for anything still unmeasured.
            const measures = await resolveVariantMeasures(
                ctx,
                this.connection,
                orderLines.map(l => l.productVariant).filter(Boolean),
            );
            const totalWeight = orderLines.reduce((weight, line) => {
                const productWeight =
                    measures.get(String(line.productVariant.id))?.grams || 500; // Default 500g
                return weight + (productWeight * line.quantity);
            }, 0);

            const weightInKg = Math.max(0.5, totalWeight / 1000);

            // Calculate dimensions from products (if available) or use defaults
            let length = 15, breadth = 10, height = 5; // Default hyperlocal-friendly dimensions
            if (orderLines.length > 0 && orderLines[0].productVariant) {
                const variantCustomFields = orderLines[0].productVariant.customFields as any;
                length = variantCustomFields?.length || 15;
                breadth = variantCustomFields?.breadth || 10;
                height = variantCustomFields?.height || 5;
            }

            // Get customer details
            const customer = order.customer;
            const customerName = customer?.firstName || shippingAddress.fullName || 'Customer';
            const customerLastName = customer?.lastName || '';
            const customerEmail = customer?.emailAddress || '';
            const customerPhone = shippingAddress.phoneNumber || customer?.phoneNumber || '';

            // Quick orders don't support COD, always use Prepaid
            const paymentMethod = 'Prepaid';

            // Get country name/code
            let countryName = 'India';
            if (shippingAddress.country) {
                if (typeof shippingAddress.country === 'string') {
                    countryName = shippingAddress.country;
                } else {
                    countryName = (shippingAddress.country as any)?.name || (shippingAddress.country as any)?.code || 'India';
                }
            }

            // Format order date with time (YYYY-MM-DD HH:mm:ss)
            const now = new Date();
            const orderDate = now.toISOString().slice(0, 19).replace('T', ' ');

            // Determine category from first product's customFields or Category facet
            let category = 'General';
            if (orderWithShipping?.lines && orderWithShipping.lines.length > 0) {
                const firstLine = orderWithShipping.lines[0];
                const product = (firstLine.productVariant as any)?.product;
                if (product) {
                    if ((product.customFields as any)?.category) {
                        category = (product.customFields as any).category;
                    } else if (product.facetValues && Array.isArray(product.facetValues)) {
                        const categoryFacet = product.facetValues.find((fv: any) =>
                            fv.facet && (fv.facet.name === 'Category' || fv.facet.code === 'category'),
                        );
                        if (categoryFacet) {
                            category = categoryFacet.name || categoryFacet.code || 'General';
                        }
                    }
                }
            }

            const orderItems = orderLines.map(line => ({
                name: line.productVariant.name,
                sku: line.productVariant.sku || line.productVariant.id.toString(),
                units: line.quantity,
                selling_price: line.unitPriceWithTax / 100, // Convert from cents
            }));

            // Auto-generate order ID for Shiprocket
            const orderId = `HL-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

            const orderData: CreateQuickOrderInput = {
                order_id: orderId,
                order_date: orderDate,
                ...(finalChannelId && { channel_id: finalChannelId }), // Only include channel_id if configured
                pickup_location: pickupLocation,
                category,
                billing_customer_name: customerName,
                billing_last_name: customerLastName,
                billing_phone: customerPhone,
                billing_address: shippingAddress.streetLine1 || '',
                billing_address_2: shippingAddress.streetLine2 || '',
                billing_city: shippingAddress.city || '',
                billing_pincode: parseInt(shippingAddress.postalCode || '0'),
                billing_state: billingState.state,
                billing_country: countryName,
                billing_email: customerEmail,
                shipping_is_billing: true,
                latitude: deliveryLat,
                longitude: deliveryLong,
                order_items: orderItems,
                payment_method: paymentMethod,
                sub_total: order.subTotal / 100, // Convert from cents
                length,
                breadth,
                height,
                weight: weightInKg,
                shipping_method: 'HL', // Required for hyperlocal delivery
            };

            const quickOrder = await this.shipRocket.createQuickOrder(orderData);

            if (quickOrder) {
                // Store Shiprocket order data in fulfillment custom fields.
                // Field names/types are shared with the international integration
                // (string columns), so ids are stored as strings.
                const fulfillmentRepo = this.connection.getRepository(ctx, 'Fulfillment');
                await fulfillmentRepo.update(
                    { id: fulfillment.id },
                    {
                        customFields: {
                            shiprocketChannelOrderId: orderId,
                            shiprocketOrderId: String(quickOrder.order_id),
                            shiprocketShipmentId: String(quickOrder.shipment_id),
                            shiprocketStatus: quickOrder.status,
                            shiprocketAwb: quickOrder.awb_code || '',
                            shiprocketCourierName: quickOrder.courier_name || '',
                            pickupLocation,
                        },
                    },
                );
                Logger.info(
                    `Shiprocket Quick order created: Order ID ${quickOrder.order_id}, Shipment ID ${quickOrder.shipment_id} for Vendure order ${order.code}`,
                    loggerCtx,
                );
            } else {
                Logger.error(`Failed to create Shiprocket Quick order for Vendure order ${order.code}`, loggerCtx);
            }
        } catch (error: any) {
            Logger.error(
                `Error creating Shiprocket Quick order for fulfillment ${fulfillment.id}: ${error.message}`,
                loggerCtx,
                error.stack,
            );
        }
    }

    /**
     * Cancel Shiprocket Quick order(s) when the Vendure order is cancelled
     */
    async cancelQuickOrderOnCancellation(ctx: RequestContext, order: Order): Promise<void> {
        try {
            // Filter in SQL — loading every fulfillment and filtering in JS exhausted the heap  
            // Only this order's fulfillments — a table-wide find() here loads the
            // entire fulfillment history with order relations and OOMs the server.
            const fulfillments =
                order.fulfillments ?? (await this.orderService.getOrderFulfillments(ctx, order));

            if (!fulfillments || fulfillments.length === 0) {
                Logger.info(`No fulfillments found for order ${order.code}`, loggerCtx);
                return;
            }

            // Collect Shiprocket order IDs from Quick fulfillments only
            const shiprocketOrderIds: number[] = [];
            for (const fulfillment of fulfillments) {
                const customFields = fulfillment.customFields as any;
                if (customFields?.fulfillmentType !== 'shiprocket-quick') {
                    continue;
                }
                const shiprocketOrderId = Number(customFields?.shiprocketOrderId);
                if (shiprocketOrderId && !isNaN(shiprocketOrderId)) {
                    shiprocketOrderIds.push(shiprocketOrderId);
                    Logger.info(
                        `Found Shiprocket order ID ${shiprocketOrderId} in fulfillment ${fulfillment.id} for order ${order.code}`,
                        loggerCtx,
                    );
                }
            }

            if (shiprocketOrderIds.length === 0) {
                Logger.info(`No Shiprocket Quick orders found to cancel for order ${order.code}`, loggerCtx);
                return;
            }

            Logger.info(
                `Cancelling ${shiprocketOrderIds.length} Shiprocket order(s) for Vendure order ${order.code}: ${shiprocketOrderIds.join(', ')}`,
                loggerCtx,
            );

            const cancelled = await this.shipRocket.cancelQuickOrder(shiprocketOrderIds);

            if (cancelled) {
                Logger.info(`Successfully cancelled Shiprocket orders for Vendure order ${order.code}`, loggerCtx);
            } else {
                Logger.warn(`Failed to cancel Shiprocket orders for Vendure order ${order.code}`, loggerCtx);
            }
        } catch (error: any) {
            Logger.error(
                `Error cancelling Shiprocket orders for order ${order.code}: ${error.message}`,
                loggerCtx,
                error.stack,
            );
        }
    }
}
