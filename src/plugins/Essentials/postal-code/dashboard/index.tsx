import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { PincodeAreaInput } from './pincode-area-input';
import { PostalCodeDetailPage } from './postal-code-detail';
import { PostalCodeListPage } from './postal-code-list';

defineDashboardExtension({
    customFormComponents: {
        customFields: [{ id: 'pincode-area-input', component: PincodeAreaInput }],
    },
    routes: [
        {
            path: '/postal-codes',
            navMenuItem: {
                sectionId: 'settings',
                id: 'postal-codes',
                url: '/postal-codes',
                title: 'Postal Codes',
            },
            loader: () => ({ breadcrumb: 'Postal Codes' }),
            component: () => <PostalCodeListPage />,
        },
        {
            path: '/postal-codes/$id',
            loader: () => ({ breadcrumb: 'Details' }),
            component: () => <PostalCodeDetailPage />,
        },
    ],
});
