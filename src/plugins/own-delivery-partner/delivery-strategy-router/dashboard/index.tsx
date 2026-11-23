import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { DeliveryInfoBlock } from './delivery-info-block';
import { KaaikaniFulfillmentInput } from './kaaikani-fulfillment-input';

defineDashboardExtension({
    customFormComponents: {
        customFields: [{ id: 'kaaikani-fulfillment-input', component: KaaikaniFulfillmentInput }],
    },
    pageBlocks: [
        {
            id: 'delivery-info',
            title: 'Delivery Assignments',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-history', order: 'before' },
            },
            component: ({ context }) => <DeliveryInfoBlock context={context} />,
        },
    ],
});
