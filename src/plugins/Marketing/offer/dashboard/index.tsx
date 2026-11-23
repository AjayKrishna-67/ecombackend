import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { OfferListPage } from './offer-list';

defineDashboardExtension({
    routes: [
        {
            path: '/offers',
            navMenuItem: {
                sectionId: 'marketing',
                id: 'offers',
                url: '/offers',
                title: 'Offers',
            },
            loader: () => ({ breadcrumb: 'Offers' }),
            component: () => <OfferListPage />,
        },
    ],
});
