import { addNavMenuItem, registerCustomDetailComponent } from '@vendure/admin-ui/core';
import { ShiprocketFulfillmentDetailComponent } from './shiprocket-fulfillment-detail.component';

export default [
    registerCustomDetailComponent({
        locationId: 'order-detail',
        component: ShiprocketFulfillmentDetailComponent,
    }),
    addNavMenuItem(
        {
            id: 'shiprocket-international-settings',
            label: 'Shiprocket International',
            routerLink: ['/extensions/shiprocket-international'],
            icon: 'airplane',
            requiresPermission: 'ReadShiprocketSettings',
        },
        'settings',
    ),
];
