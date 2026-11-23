import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';

import { OrderLocationBlock } from './order-location-block';
import { OrderTableWithPickupTime } from './order-table-with-pickup-time';

defineDashboardExtension({
    pageBlocks: [
        {
            // Replaces the dashboard's order table with a copy whose Shipping
            // row also shows a Take Away order's pickup time next to the
            // shipping method. See the header comment of the component.
            id: 'order-table',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-table', order: 'replace' },
            },
            component: ({ context }) =>
                context.entity ? (
                    <OrderTableWithPickupTime order={context.entity} pageId={context.pageId ?? 'order-detail'} />
                ) : null,
        },
        {
            id: 'delivery-location-map',
            title: 'Delivery location',
            location: {
                pageId: 'order-detail',
                column: 'side',
                position: { blockId: 'customer', order: 'after' },
            },
            component: ({ context }) => <OrderLocationBlock context={context} />,
        },
    ],
});
