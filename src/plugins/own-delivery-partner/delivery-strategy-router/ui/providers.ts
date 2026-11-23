import { registerCustomDetailComponent, registerFormInputComponent } from '@vendure/admin-ui/core';
import { DeliveryInfoComponent } from './delivery-info.component';
import { KaaikaniFulfillmentInputComponent } from './kaaikani-fulfillment-input.component';

export default [
    registerCustomDetailComponent({
        locationId: 'order-detail',
        component: DeliveryInfoComponent,
    }),
    registerFormInputComponent('kaaikani-fulfillment-input', KaaikaniFulfillmentInputComponent),
];
