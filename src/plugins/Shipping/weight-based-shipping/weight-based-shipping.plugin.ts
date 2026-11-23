import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { weightBasedShippingCalculator } from './Shipping/weight-based-shipping-calculator';

@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.0.0',
    configuration: config => {
        config.shippingOptions.shippingCalculators.push(weightBasedShippingCalculator);
        return config;
    },
})
export class WeightBasedShippingPlugin {}

