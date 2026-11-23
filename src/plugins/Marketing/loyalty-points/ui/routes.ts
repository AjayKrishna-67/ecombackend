import { registerRouteComponent } from '@vendure/admin-ui/core';
import { LoyaltyPointsConfigComponent } from './LoyaltyPointsConfigComponent';

export default [
    registerRouteComponent({
        component: LoyaltyPointsConfigComponent,
        path: '',
        title: 'Rewards Points',
        breadcrumb: 'Loyality',
    }),
];
