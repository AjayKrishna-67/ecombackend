import { OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, OrderPlacedEvent, PluginCommonModule, SettingsStoreScopes, VendurePlugin } from '@vendure/core';
import { adminApiExtensions } from './api/api-extensions';
import { AbandonedCartAdminResolver } from './api/abandoned-cart-admin.resolver';
import { AbandonedCartEvent } from './entities/abandoned-cart-event.entity';
import { AbandonedCartNudge } from './entities/abandoned-cart-nudge.entity';
import { readAbandonedCartPermission, updateAbandonedCartPermission } from './permissions';
import { AbandonedCartService } from './services/abandoned-cart.service';
import { Msg91Service } from './services/msg91.service';
import { abandonedCartSweepTask } from './tasks/abandoned-cart-sweep.task';

/**
 * Abandoned-cart re-engagement. Channel-scoped config authored in the Customer Analytics
 * UI; a worker sweep nudges eligible carts via MSG91 WhatsApp utility templates. Subscribes to
 * OrderPlacedEvent to record conversions for analytics.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    entities: [AbandonedCartNudge, AbandonedCartEvent],
    providers: [AbandonedCartService, Msg91Service],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [AbandonedCartAdminResolver],
    },
    configuration: config => {
        config.authOptions.customPermissions.push(readAbandonedCartPermission, updateAbandonedCartPermission);
        const requiresPermission = {
            read: readAbandonedCartPermission.Permission,
            write: updateAbandonedCartPermission.Permission,
        };
        config.settingsStoreFields = config.settingsStoreFields ?? {};
        config.settingsStoreFields.abandonedCart = [
            { name: 'config', scope: SettingsStoreScopes.channel, requiresPermission },
        ];
        config.schedulerOptions = config.schedulerOptions ?? {};
        config.schedulerOptions.tasks = [...(config.schedulerOptions.tasks ?? []), abandonedCartSweepTask];
        return config;
    },
})
export class AbandonedCartPlugin implements OnApplicationBootstrap {
    constructor(
        private readonly eventBus: EventBus,
        private readonly service: AbandonedCartService,
    ) {}

    onApplicationBootstrap(): void {
        // A placed order that was previously nudged counts as a conversion. Failures are logged,
        // never thrown — analytics must not break order placement.
        this.eventBus.ofType(OrderPlacedEvent).subscribe(event => {
            this.service
                .recordConversion(event.ctx, event.order)
                .catch(error => console.error('[AbandonedCart] recordConversion failed:', error));
        });
    }
}
