import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { TagsBlock } from './tags-block';
import { TagsDetailPage } from './tags-detail';
import { TagsListPage } from './tags-list';

defineDashboardExtension({
    routes: [
        {
            path: '/tags',
            navMenuItem: {
                sectionId: 'settings',
                id: 'tags',
                url: '/tags',
                title: 'Tags',
                requiresPermission: 'ReadCatalog',
            },
            loader: () => ({ breadcrumb: 'Tags' }),
            component: () => <TagsListPage />,
        },
        {
            path: '/tags/$id',
            loader: () => ({ breadcrumb: 'Tag' }),
            component: () => <TagsDetailPage />,
        },
    ],
    pageBlocks: [
        {
            id: 'product-tags',
            title: 'Tags',
            location: {
                pageId: 'product-detail',
                column: 'side',
                position: { blockId: 'facet-values', order: 'after' },
            },
            requiresPermission: 'ReadCatalog',
            component: ({ context }) => <TagsBlock context={context} entityType="product" />,
        },
        {
            id: 'variant-tags',
            title: 'Tags',
            location: {
                pageId: 'product-variant-detail',
                column: 'side',
                position: { blockId: 'facet-values', order: 'after' },
            },
            requiresPermission: 'ReadCatalog',
            component: ({ context }) => <TagsBlock context={context} entityType="variant" />,
        },
    ],
});
