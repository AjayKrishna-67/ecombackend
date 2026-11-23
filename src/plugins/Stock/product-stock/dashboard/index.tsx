import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { ProductStockBlock } from './product-stock-block';
import { VariantPoolNotice } from './variant-pool-notice';

defineDashboardExtension({
    // The `productStockEnabled` custom field is rendered as a Switch inside the
    // Product Stock block below. Registering a no-op input here stops the
    // dashboard from also auto-rendering a duplicate field in the custom-fields area.
    customFormComponents: {
        customFields: [
            {
                id: 'product-stock-toggle-suppressed',
                component: () => null,
            },
        ],
    },
    pageBlocks: [
        {
            id: 'product-stock-manager',
            title: 'Product Stock',
            location: {
                pageId: 'product-detail',
                column: 'main',
                position: { blockId: 'custom-fields', order: 'after' },
            },
            requiresPermission: 'ReadCatalog',
            component: ({ context }) => <ProductStockBlock context={context} />,
        },
        {
            // Sits directly above the core Stock box on the variant page, which
            // for a pooled product shows a figure derived from the pool and
            // silently discards anything typed into it. 'before' rather than
            // 'replace': the same box is the real editor for every non-pooled
            // product, and the notice renders nothing when the pool is off.
            id: 'variant-pool-notice',
            location: {
                pageId: 'product-variant-detail',
                column: 'main',
                position: { blockId: 'stock', order: 'before' },
            },
            requiresPermission: 'ReadCatalog',
            component: ({ context }) => <VariantPoolNotice context={context} />,
        },
    ],
});
