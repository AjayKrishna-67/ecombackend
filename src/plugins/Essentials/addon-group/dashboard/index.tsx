import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { AddonGroupDetailPage } from './addon-group-detail';
import { AddonGroupListPage } from './addon-group-list';
import { AddonGroupRelationInput } from './addon-group-relation-input';
import { AddonOrderBlock } from './addon-order-block';

defineDashboardExtension({
    customFormComponents: {
        customFields: [{ id: 'addon-group-relation-input', component: AddonGroupRelationInput }],
    },
    pageBlocks: [
        {
            id: 'addon-selections',
            title: 'Addons',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-history', order: 'before' },
            },
            component: ({ context }) => <AddonOrderBlock context={context} />,
        },
    ],
    routes: [
        {
            path: '/addon-groups',
            navMenuItem: {
                sectionId: 'catalog',
                id: 'addon-groups',
                url: '/addon-groups',
                title: 'Addon Groups',
                requiresPermission: 'ReadAddonGroup',
            },
            loader: () => ({ breadcrumb: 'Addon Groups' }),
            component: () => <AddonGroupListPage />,
        },
        {
            path: '/addon-groups/$id',
            loader: () => ({ breadcrumb: 'Details' }),
            component: () => <AddonGroupDetailPage />,
        },
    ],
});
