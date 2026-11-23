import { registerCustomDetailComponent, registerFormInputComponent } from '@vendure/admin-ui/core';

import { AdloggsFulfillmentDetailComponent } from './adloggs-fulfillment-detail.component';
import { AdloggsPickupConfigInputComponent } from './pickup-config-input.component';

export default [
    // "Pickup Store" map picker inside the shipping method's Calculator card
    // (the Adloggs calculator's `pickupConfig` arg).
    registerFormInputComponent('adloggs-pickup-config-input', AdloggsPickupConfigInputComponent),
    // "Adloggs Delivery" card on the order-detail page.
    registerCustomDetailComponent({
        locationId: 'order-detail',
        component: AdloggsFulfillmentDetailComponent,
    }),
];
