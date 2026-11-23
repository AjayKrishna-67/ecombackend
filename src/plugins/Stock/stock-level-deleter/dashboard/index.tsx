import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { StockLocationsBlock } from './stock-locations-block';

defineDashboardExtension({
    pageBlocks: [
        {
            id: 'stock',
            title: 'Stock',
            location: {
                pageId: 'product-variant-detail',
                column: 'main',
                position: { blockId: 'stock', order: 'replace' },
            },
            requiresPermission: 'UpdateCatalog',
            component: ({ context }) => <StockLocationsBlock context={context} />,
        },
    ],
});
