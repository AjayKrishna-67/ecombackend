import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { ReferralSummaryWidget } from './referral-summary-widget';
import { ReferredByBlock } from './referred-by-block';

defineDashboardExtension({
    widgets: [
        {
            id: 'referral-summary-widget',
            name: 'Referral Summary',
            component: ReferralSummaryWidget,
            defaultSize: { w: 6, h: 4 },
            minSize: { w: 4, h: 3 },
            requiresPermissions: ['SuperAdmin'],
        },
    ],
    pageBlocks: [
        {
            id: 'referred-by',
            title: 'Referral',
            location: {
                pageId: 'customer-detail',
                column: 'side',
                position: { blockId: 'customer-groups', order: 'after' },
            },
            component: ({ context }) => <ReferredByBlock context={context} />,
        },
    ],
});
