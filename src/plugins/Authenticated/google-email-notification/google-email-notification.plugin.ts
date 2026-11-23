// src/plugins/google-email-notification/google-email-notification.plugin.ts
import {
  PluginCommonModule,
  VendurePlugin,
  EventBus,
  AccountRegistrationEvent,
  OrderPlacedEvent,
  OrderStateTransitionEvent,
} from '@vendure/core';
import { OnApplicationBootstrap } from '@nestjs/common';
import { BrandEmailService } from './brand-email.service';

@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [BrandEmailService],
  compatibility: '^3.6.3',
  configuration: (config) => {
    return config;
  },
})
export class GoogleEmailNotificationPlugin implements OnApplicationBootstrap {
  constructor(
    private eventBus: EventBus,
    private brandEmailService: BrandEmailService,
  ) {}

  async onApplicationBootstrap() {
    // Subscribe to AccountRegistrationEvent for welcome emails
    this.eventBus.ofType(AccountRegistrationEvent).subscribe(async (event) => {
      try {
        // Check if user has Google auth
        const hasGoogleAuth =
          event.user?.authenticationMethods?.some((method: any) => method.strategy === 'google') ?? false;

        if (hasGoogleAuth) {
          // Get channel token from context
          const channelToken = event.ctx?.channel?.token || null;
          
          // Check if this channel matches a brand config
          const { getBrandConfigByChannelToken } = await import('./email-handlers');
          const brandConfig = getBrandConfigByChannelToken(channelToken);
          
          if (brandConfig) {
            await this.brandEmailService.sendWelcomeEmail(event);
          }
        }
      } catch (error: any) {
        console.error('Error in AccountRegistrationEvent handler:', error);
      }
    });

    // Subscribe to OrderPlacedEvent for order receipt emails
    this.eventBus.ofType(OrderPlacedEvent).subscribe(async (event) => {
      try {
        const channelToken = event.ctx?.channel?.token || null;
        const { getBrandConfigByChannelToken } = await import('./email-handlers');
        const brandConfig = getBrandConfigByChannelToken(channelToken);
        
        if (brandConfig && event.order.customer) {
          await this.brandEmailService.sendOrderReceiptEmail(event);
        }
      } catch (error: any) {
        console.error('Error in OrderPlacedEvent handler:', error);
      }
    });

    // Subscribe to OrderStateTransitionEvent for cancelled and delivered emails
    this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async (event) => {
      try {
        const channelToken = event.ctx?.channel?.token || null;
        const { getBrandConfigByChannelToken } = await import('./email-handlers');
        const brandConfig = getBrandConfigByChannelToken(channelToken);
        
        if (brandConfig && event.order.customer) {
          if (event.toState === 'Cancelled') {
            await this.brandEmailService.sendOrderCancelledEmail(event);
          } else if (event.toState === 'Delivered') {
            await this.brandEmailService.sendOrderDeliveredEmail(event);
          }
        }
      } catch (error: any) {
        console.error('Error in OrderStateTransitionEvent handler:', error);
      }
    });
  }
}

