import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { LoyaltyPointsConfigPage } from './loyalty-config';

defineDashboardExtension({
    routes: [
        {
            path: '/loyalty-points',
            navMenuItem: {
                sectionId: 'marketing',
                id: 'loyalty-points',
                url: '/loyalty-points',
                title: 'Loyalty Points',
            },
            loader: () => ({ breadcrumb: 'Loyalty Points' }),
            component: () => <LoyaltyPointsConfigPage />,
        },
    ],
});
