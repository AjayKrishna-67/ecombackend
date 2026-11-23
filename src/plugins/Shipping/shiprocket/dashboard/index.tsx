import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';

import { ShiprocketOrderBlock } from '../international/dashboard/order-shiprocket-block';
import { ShiprocketSettingsPage } from '../international/dashboard/shiprocket-settings-page';
import { ShiprocketQuickOrderBlock } from './order-shiprocket-quick-block';

/**
 * Single dashboard entry for the merged ShiprocketPlugin:
 * - International: settings page + order-detail shipment block
 * - Quick: order-detail card with live data, Refresh and Ship Now
 */
defineDashboardExtension({
    routes: [
        {
            path: '/shiprocket-international',
            navMenuItem: {
                sectionId: 'settings',
                id: 'shiprocket-international',
                url: '/shiprocket-international',
                title: 'Shiprocket International',
                // SuperAdmin fallback so the owner isn't locked out before the custom
                // permission is granted to a role (hasPermissions = OR).
                requiresPermission: ['ReadShiprocketSettings', 'SuperAdmin'],
            },
            loader: () => ({ breadcrumb: 'Shiprocket International' }),
            component: () => <ShiprocketSettingsPage />,
        },
    ],
    pageBlocks: [
        {
            id: 'shiprocket-shipment',
            title: 'Shiprocket International',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-history', order: 'before' },
            },
            component: ({ context }) => <ShiprocketOrderBlock context={context} />,
            // Only for international fulfillments — Quick orders get their own block below.
            shouldRender: ({ entity }: any) =>
                Array.isArray(entity?.fulfillments) &&
                entity.fulfillments.some((f: any) => {
                    const method = (f?.method ?? '').toLowerCase();
                    return method.includes('shiprocket') && !method.includes('quick');
                }),
        },
        {
            id: 'shiprocket-quick-order',
            title: 'Shiprocket Quick',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-history', order: 'before' },
            },
            component: ({ context }) => <ShiprocketQuickOrderBlock context={context} />,
            // Quick fulfillments are created by the KaaiKani handler with method "Shiprocket Quick".
            shouldRender: ({ entity }: any) =>
                Array.isArray(entity?.fulfillments) &&
                entity.fulfillments.some((f: any) =>
                    (f?.method ?? '').toLowerCase().includes('shiprocket quick'),
                ),
        },
    ],
});
