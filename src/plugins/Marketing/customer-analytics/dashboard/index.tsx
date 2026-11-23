import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { CustomerAnalyticsPage } from './customer-analytics-page';

defineDashboardExtension({
    routes: [
        {
            path: '/customer-analytics',
            navMenuItem: {
                sectionId: 'customers',
                id: 'customer-analytics',
                url: '/customer-analytics',
                title: 'Customer Analytics',
                // SuperAdmin fallback so the owner is never locked out before the custom
                // permission is assigned to a role on first deploy (hasPermissions = OR).
                requiresPermission: ['ReadCustomerAnalytics', 'SuperAdmin'],
            },
            loader: () => ({ breadcrumb: 'Customer Analytics' }),
            component: () => <CustomerAnalyticsPage />,
        },
    ],
});
