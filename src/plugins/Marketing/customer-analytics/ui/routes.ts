import { registerRouteComponent } from '@vendure/admin-ui/core';
import { CustomerAnalyticsListComponent } from './customer-analytics-list.component';
import { customerAnalyticsGuard } from './customer-analytics.guard';

export default [
    registerRouteComponent({
        component: CustomerAnalyticsListComponent,
        path: '',
        title: 'Customer Analytics',
        breadcrumb: [{ label: 'Customer Analytics', link: ['/extensions', 'customer-analytics'] }],
        // Route hard-gate: redirect unauthorized deep-links instead of rendering an empty shell.
        routeConfig: { canActivate: [customerAnalyticsGuard] },
    }),
];
