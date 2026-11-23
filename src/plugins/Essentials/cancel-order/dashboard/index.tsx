import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { CancelOrderAlertsBlock } from './cancel-order-alerts-block';

defineDashboardExtension({
    pageBlocks: [
        {
            id: 'cancel-order-alerts',
            title: 'Order Cancellation Alerts',
            location: {
                pageId: 'global-settings',
                column: 'main',
                position: { blockId: 'main-form', order: 'after' },
            },
            // Read gate only — the Save button is separately gated on UpdateGlobalSettings
            // inside the block, matching the SettingsStore field's requiresPermission.
            requiresPermission: 'ReadSettings',
            component: () => <CancelOrderAlertsBlock />,
        },
    ],
});
