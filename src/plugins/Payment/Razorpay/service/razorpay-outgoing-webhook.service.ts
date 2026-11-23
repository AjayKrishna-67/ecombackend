// src/plugins/Payment/Razorpay/service/razorpay-outgoing-webhook.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus, OrderStateTransitionEvent, Logger } from '@vendure/core';

/**
 * RazorpayOutgoingWebhookService
 *
 * Listens for order state transitions and notifies external systems
 * when a payment is successfully settled.
 *
 * This embeds the functionality of vendure-plugin-webhook directly
 * into the Razorpay plugin for seamless integration.
 */
@Injectable()
export class RazorpayOutgoingWebhookService implements OnModuleInit {
    constructor(private eventBus: EventBus) {}

    onModuleInit() {
        // Subscribe to order state transition events
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async (event) => {
            // Only notify when order transitions to PaymentSettled
            if (event.toState === 'PaymentSettled') {
                await this.notifyExternalSystems(event);
            }
        });
    }

    /**
     * Notify external systems about the successful payment
     *
     * @param event The order state transition event
     */
    private async notifyExternalSystems(event: OrderStateTransitionEvent) {
        // You can fetch a URL from a custom field or environment variable
        const webhookUrl = process.env.ORDER_PLACED_WEBHOOK_URL;

        if (!webhookUrl) {
            // No webhook URL configured, skip notification
            return;
        }

        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Vendure-Razorpay-Plugin'
                },
                body: JSON.stringify({
                    event: 'order.placed',
                    orderCode: event.order.code,
                    orderId: event.order.id,
                    total: event.order.totalWithTax,
                    currencyCode: event.order.currencyCode,
                    channel: event.ctx.channel.code,
                    channelToken: event.ctx.channel.token,
                    customerEmail: event.order.customer?.emailAddress,
                    placedAt: event.order.orderPlacedAt,
                    timestamp: new Date().toISOString()
                }),
            });

            if (response.ok) {
                Logger.info(`Outgoing webhook sent for order ${event.order.code}`, 'RazorpayPlugin');
            } else {
                Logger.warn(
                    `Outgoing webhook failed with status ${response.status} for order ${event.order.code}`,
                    'RazorpayPlugin'
                );
            }
        } catch (e: any) {
            Logger.error(
                `Failed to send outgoing webhook for order ${event.order.code}: ${e.message}`,
                'RazorpayPlugin'
            );
        }
    }
}
