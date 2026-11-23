// src/plugins/shiprocket/api/ship-rocket-shop.resolver.ts
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Ctx, Logger, RequestContext } from '@vendure/core';
import { ShipRocket } from '../services/ship-rocket';
import { ShippingOption } from '../types';
import { loggerCtx } from '../constants';

interface ShippingRateInput {
    pickupPostcode: string;
    deliveryPostcode: string;
    weight: number;
    orderValue: number;
    enableCOD?: boolean;
}

@Resolver()
export class ShipRocketShopResolver {
    constructor(private shipRocket: ShipRocket) {}

    @Query()
    async getShippingOptions(
        @Args('input') input: ShippingRateInput,
        @Ctx() ctx: RequestContext,
    ): Promise<ShippingOption[]> {
        try {
            Logger.info('Fetching shipping options via GraphQL API...', loggerCtx);

            const rateParams = {
                pickup_postcode: input.pickupPostcode,
                delivery_postcode: input.deliveryPostcode,
                weight_in_kg: input.weight,
                order_value: input.orderValue / 100, // Convert from cents to currency units
                is_cod: input.enableCOD || false,
            };

            const courierOptions = await this.shipRocket.getShippingRates(rateParams);

            const shippingOptions: ShippingOption[] = courierOptions.map((option, index) => ({
                id: `${option.courier_company_id}-${index}`,
                name: option.courier_name,
                description: `Delivery in ${option.estimated_delivery_days} days`,
                price: Math.round(option.rate * 100), // Convert to cents for Money type
                estimatedDeliveryDays: option.estimated_delivery_days,
                courierName: option.courier_name,
                etd: option.etd,
                trackingAvailable: option.realtime_tracking === 'Real Time',
                codAvailable: option.cod === 1,
            }));

            Logger.info(`Returning ${shippingOptions.length} shipping options`, loggerCtx);
            return shippingOptions;

        } catch (error: any) {
            Logger.error(`Error fetching shipping options: ${error.message}`, loggerCtx);
            return [];
        }
    }
}