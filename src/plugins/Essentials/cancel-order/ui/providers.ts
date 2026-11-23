import { registerCustomDetailComponent } from '@vendure/admin-ui/core';
import { CancelOrderAlertsComponent } from './cancel-order-alerts.component';

export default [
    registerCustomDetailComponent({
        locationId: 'global-settings-detail',
        component: CancelOrderAlertsComponent,
    }),
];
