import { registerFormInputComponent } from '@vendure/admin-ui/core';

import { TakeAwayFieldBridgeComponent } from './field-bridge-input.component';
import { StoreLocationArgComponent } from './store-location-arg.component';
import { TakeAwaySuppressedInputComponent } from './suppressed-input.component';

export default [
    // The full Store Location picker, rendered inside the Calculator card as
    // the take-away calculator's `storeLocation` arg.
    registerFormInputComponent('take-away-store-location-arg', StoreLocationArgComponent),
    // ShippingMethod store-location custom fields: rows hidden, controls
    // exposed to the picker via StoreLocationBridge.
    registerFormInputComponent('take-away-field-bridge', TakeAwayFieldBridgeComponent),
    // Order snapshot fields: rows hidden (order-location-map shows the data).
    registerFormInputComponent('take-away-suppressed-input', TakeAwaySuppressedInputComponent),
];
