import { defineDashboardExtension } from '@vendure/dashboard';

import { TakeAwayFieldBridgeInput } from './field-bridge';
import { StoreLocationArg } from './store-location-arg';
import { TakeAwaySuppressedInput } from './suppressed-input';

defineDashboardExtension({
    customFormComponents: {
        customFields: [
            // The full Store Location picker, rendered inside the Calculator
            // card as the take-away calculator's `storeLocation` arg. Writes
            // through the field bridge below.
            { id: 'take-away-store-location-arg', component: StoreLocationArg },
            // ShippingMethod store-location custom fields: rows hidden, form
            // controllers registered with the bridge for the picker to use.
            { id: 'take-away-field-bridge', component: TakeAwayFieldBridgeInput },
            // Order snapshot fields: rows hidden (order-location-map shows
            // the pickup store card instead).
            { id: 'take-away-suppressed-input', component: TakeAwaySuppressedInput },
        ],
    },
});
