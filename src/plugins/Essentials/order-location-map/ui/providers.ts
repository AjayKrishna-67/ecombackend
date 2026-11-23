import { registerCustomDetailComponent } from '@vendure/admin-ui/core';

import { OrderLocationMapComponent } from './order-location-map.component';
import { OrderPickupTimeRowComponent } from './order-pickup-time-row.component';

export default [
    registerCustomDetailComponent({
        locationId: 'order-detail',
        component: OrderLocationMapComponent,
    }),
    // Renders nothing itself: writes the pickup time chip into the order
    // table's Shipping row.
    registerCustomDetailComponent({
        locationId: 'order-detail',
        component: OrderPickupTimeRowComponent,
    }),
];
