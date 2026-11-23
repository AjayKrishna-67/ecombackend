import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { AdminActivityListPage } from './activity-list';
import { EntityHistoryBlock } from './entity-history';
import { AdminActivitySessionDetailPage, AdminActivitySessionsPage } from './session-timeline';

defineDashboardExtension({
    /**
     * Answers "what happened to this product" on the product's own page, rather
     * than making someone go to Admin Activity and filter for it. Anchored after
     * the variants table so it reads as the last section of the main column,
     * matching where Order and Customer history sit.
     */
    pageBlocks: [
        {
            id: 'admin-activity-history',
            title: 'Admin Activity',
            location: {
                pageId: 'product-detail',
                position: { blockId: 'product-variants-table', order: 'after' },
                column: 'main',
            },
            component: ({ context }) => <EntityHistoryBlock context={context} entityType="Product" />,
        },
        {
            /**
             * The same block on the variant page. `EntityHistoryBlock` already
             * took the entity type as a prop, so a second surface costs one
             * registration and no new component.
             *
             * Anchored after `stock`, which is the last block in that page's main
             * column — the same relative position the product block occupies
             * after `product-variants-table`.
             */
            id: 'admin-activity-history-variant',
            title: 'Admin Activity',
            location: {
                pageId: 'product-variant-detail',
                position: { blockId: 'stock', order: 'after' },
                column: 'main',
            },
            component: ({ context }) => (
                <EntityHistoryBlock context={context} entityType="ProductVariant" />
            ),
        },
    ],
    routes: [
        {
            path: '/admin-activity',
            navMenuItem: {
                sectionId: 'system',
                id: 'admin-activity',
                url: '/admin-activity',
                title: 'Admin Activity',
            },
            loader: () => ({ breadcrumb: 'Admin Activity' }),
            component: () => <AdminActivityListPage />,
        },
        {
            path: '/admin-activity/sessions',
            loader: () => ({ breadcrumb: 'Work Sessions' }),
            component: () => <AdminActivitySessionsPage />,
        },
        {
            path: '/admin-activity/sessions/$sessionId',
            loader: () => ({ breadcrumb: 'Session' }),
            component: () => <AdminActivitySessionDetailPage />,
        },
    ],
});
