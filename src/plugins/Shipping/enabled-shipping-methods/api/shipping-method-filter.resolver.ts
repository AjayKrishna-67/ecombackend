import { Query, Resolver } from '@nestjs/graphql';
import {
    Ctx,
    RequestContext,
    ShippingMethodService,
    Logger,
} from '@vendure/core';

const loggerCtx = 'ShippingMethodFilterResolver';

@Resolver()
export class ShippingMethodFilterResolver {
    constructor(
        private shippingMethodService: ShippingMethodService,
    ) {}

    /**
     * Get eligible shipping methods that are enabled.
     *
     * Returns only shipping methods where the 'enabled' custom field is true.
     * This query provides the same functionality as activeOrder.eligibleShippingMethods
     * but filters out disabled methods.
     *
     * Usage:
     * query {
     *   eligibleShippingMethodsEnabled {
     *     id
     *     name
     *     code
     *     description
     *     price
     *     priceWithTax
     *     metadata
     *   }
     * }
     */
    @Query()
    async eligibleShippingMethodsEnabled(
        @Ctx() ctx: RequestContext,
    ): Promise<any[]> {
        try {
            // Get all active shipping methods
            const allMethods = await this.shippingMethodService.getActiveShippingMethods(ctx);

            if (!allMethods || allMethods.length === 0) {
                Logger.debug(`No active shipping methods found`, loggerCtx);
                return [];
            }

            // Filter to only include enabled methods
            const enabledMethods = allMethods.filter(method => {
                // Check if method is enabled via custom field (default: true for backward compatibility)
                const isEnabled = ((method.customFields as any)?.enabled ?? true) as boolean;

                if (!isEnabled) {
                    Logger.info(
                        `Filtering out disabled shipping method: ${method.name} (ID: ${method.id})`,
                        loggerCtx
                    );
                }

                return isEnabled;
            });

            Logger.debug(
                `Eligible shipping methods: ${allMethods.length} total, ${enabledMethods.length} enabled`,
                loggerCtx
            );

            return enabledMethods;
        } catch (error: any) {
            Logger.error(
                `Error getting eligible shipping methods: ${error.message}`,
                loggerCtx,
                error.stack
            );
            // In case of error, return empty array to fail safely
            return [];
        }
    }
}
