// src/plugins/OrderDeviceMedium/order-device-medium.plugin.ts
import {
  VendurePlugin, PluginCommonModule, OrderStateTransitionEvent, EventBus,
  OrderService, RequestContext, Logger
} from '@vendure/core';
import { OnApplicationBootstrap } from '@nestjs/common';

/**
 * Custom order fields for tracking platform and device information.
 * - platform: The business platform (e.g., "Kaaikani", "Southmithat")
 * - deviceMedium: The device type (e.g., "Android", "iOS", "Website", "App")
 */
declare module '@vendure/core/dist/entity/custom-entity-fields' {
  interface CustomOrderFields {
    platform?: string;
    deviceMedium?: string;
  }
}

interface DeviceInfo {
  platform: string | null;
  deviceMedium: string;
  isDeviceFromHeader: boolean;
}

/**
 * Plugin to track order source platform and device type.
 *
 * Client-side headers (full control):
 * - `x-platform`: Platform name (e.g., "Kaaikani", "Southmithat")
 * - `x-device-medium`: Device type (e.g., "Android", "iOS", "Website", "App")
 *
 * Both values are accepted as-is from the client, allowing dynamic platform support
 * without code changes.
 */
@VendurePlugin({
  imports: [PluginCommonModule],
  compatibility: '^3.6.3',
})
export class OrderDeviceMediumPlugin implements OnApplicationBootstrap {
  constructor(
    private eventBus: EventBus,
    private orderService: OrderService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.eventBus.ofType(OrderStateTransitionEvent).subscribe(async (event) => {
      const { ctx, order, toState } = event;
      const deviceInfo = this.extractDeviceInfo(ctx);
      const updates = this.buildUpdates(order.customFields, deviceInfo);

      if (Object.keys(updates).length === 0) return;

      try {
        await this.orderService.updateCustomFields(ctx, order.id, updates);
        Logger.info(
          `[DevicePlugin] Order ${order.code} updated: platform="${updates.platform ?? order.customFields.platform}", device="${updates.deviceMedium ?? order.customFields.deviceMedium}" (state: ${toState})`,
          'OrderDeviceMediumPlugin'
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(
          `[DevicePlugin] Failed to update ${order.code}: ${message}`,
          'OrderDeviceMediumPlugin'
        );
      }
    });
  }

  /**
   * Extracts platform and device information from request headers.
   * Client has full control - values are accepted as-is.
   */
  private extractDeviceInfo(ctx: RequestContext): DeviceInfo {
    const headers = ctx.req?.headers;

    // Platform: Fully client-controlled, no fallback
    const platform = headers?.['x-platform']?.toString().trim() || null;

    // Device: Client-controlled with User-Agent fallback
    const deviceHeader = headers?.['x-device-medium']?.toString().trim();
    const isDeviceFromHeader = !!deviceHeader;
    const deviceMedium = deviceHeader || this.detectDeviceFromUserAgent(ctx);

    return { platform, deviceMedium, isDeviceFromHeader };
  }

  /**
   * Fallback device detection from User-Agent when header is not provided.
   */
  private detectDeviceFromUserAgent(ctx: RequestContext): string {
    const ua = ctx.req?.headers['user-agent']?.toLowerCase() || '';

    if (ua.includes('android')) return 'Android';
    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ios')) return 'iOS';
    if (ua.includes('windows') || ua.includes('macintosh')) return 'Website';

    return ctx.apiType === 'admin' ? 'Phone' : 'Website';
  }

  /**
   * Builds the update payload:
   * - Platform: Updates whenever client explicitly sends a different value
   * - Device: Updates if empty, OR if client explicitly sends a different value via header
   * - User-Agent fallback only applies when field is empty (won't overwrite explicit values)
   */
  private buildUpdates(
    currentFields: { platform?: string; deviceMedium?: string },
    deviceInfo: DeviceInfo
  ): Partial<{ platform: string; deviceMedium: string }> {
    const updates: Partial<{ platform: string; deviceMedium: string }> = {};

    // Platform: Update if client explicitly sent a different value
    if (deviceInfo.platform && deviceInfo.platform !== currentFields.platform) {
      updates.platform = deviceInfo.platform;
    }

    // Device: Update if empty, OR if client sent explicit header with different value
    const shouldUpdateDevice =
      !currentFields.deviceMedium ||
      (deviceInfo.isDeviceFromHeader && deviceInfo.deviceMedium !== currentFields.deviceMedium);

    if (shouldUpdateDevice) {
      updates.deviceMedium = deviceInfo.deviceMedium;
    }

    return updates;
  }
}