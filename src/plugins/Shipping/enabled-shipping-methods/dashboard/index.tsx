import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { ShippingMethodEnabledBlock } from './shipping-method-enabled-block';
import { ShippingMethodToggle } from './shipping-method-toggle';

defineDashboardExtension({
    customFormComponents: {
        customFields: [{ id: 'app-shipping-method-toggle', component: ShippingMethodToggle }],
    },
    pageBlocks: [
        {
            id: 'shipping-method-enabled',
            title: 'Enabled',
            location: {
                pageId: 'shipping-method-detail',
                column: 'side',
                position: { blockId: 'custom-fields', order: 'after' },
            },
            component: ({ context }) => <ShippingMethodEnabledBlock context={context} />,
        },
    ],
});
