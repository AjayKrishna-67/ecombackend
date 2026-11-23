import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';

import { OrderAdloggsBlock } from './order-adloggs-block';
import { AdloggsPickupConfigInput } from './pickup-config-input';

/**
 * Dashboard entry for the AdloggsPlugin:
 * - "Pickup Store" map picker rendered inside the shipping method's Calculator
 *   card as the Adloggs calculator's `pickupConfig` arg component.
 * - "Adloggs Delivery" card on the order-detail page (status, rider, fee,
 *   tracking link, Sync/Retry).
 */
defineDashboardExtension({
    customFormComponents: {
        customFields: [{ id: 'adloggs-pickup-config-input', component: AdloggsPickupConfigInput }],
    },
    pageBlocks: [
        {
            id: 'adloggs-delivery',
            title: 'Adloggs Delivery',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-history', order: 'before' },
            },
            component: ({ context }) => <OrderAdloggsBlock context={context} />,
            // Adloggs fulfillments are created by the KaaiKani handler with method "Adloggs".
            shouldRender: ({ entity }: any) =>
                Array.isArray(entity?.fulfillments) &&
                entity.fulfillments.some((f: any) => (f?.method ?? '').toLowerCase() === 'adloggs'),
        },
    ],
});
