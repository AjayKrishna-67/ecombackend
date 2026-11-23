import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { BannerListPage } from './banner-list';

defineDashboardExtension({
    routes: [
        {
            path: '/banners',
            navMenuItem: {
                sectionId: 'marketing',
                id: 'banners',
                url: '/banners',
                title: 'Banners',
            },
            loader: () => ({ breadcrumb: 'Banners' }),
            component: () => <BannerListPage />,
        },
    ],
});
