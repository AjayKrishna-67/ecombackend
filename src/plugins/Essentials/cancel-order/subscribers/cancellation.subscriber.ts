// src/plugins/Essentials/cancel-order/subscribers/cancellation.subscriber.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventBus, OrderStateTransitionEvent } from '@vendure/core';
import { Msg91Service } from '../services/msg91.service';

@Injectable()
export class CancellationSubscriber implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private msg91Service: Msg91Service
    ) {
        // ADD THIS LOG
        console.log('✅ CancellationSubscriber Initialized! (If you do not see this, the plugin is not loaded)');
    }

    onModuleInit() {
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async (event) => {
            // Log EVERY transition to see what is happening
            console.log(`[Subscriber Debug] Transition: ${event.fromState} -> ${event.toState}`);

            if ((event.toState as string) === 'CancellationRequested') {
                console.log('✅ Cancellation Detected! Preparing to send message...');
                
                const customer = event.order.customer;
                if (customer && customer.phoneNumber) {
                    // ctx carries the channel the cancellation was requested in, which is what
                    // scopes the SettingsStore read to that channel's recipient list. The
                    // transition is only ever triggered by the shop-side requestOrderCancellation
                    // mutation, so ctx.channel is the customer's channel, not an admin's.
                    await this.msg91Service.sendOrderCancellationWhatsapp(
                        event.ctx,
                        customer.phoneNumber,
                        customer.firstName,
                        event.order.code
                    );
                }
            }
        });
    }
}