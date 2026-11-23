import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { ExportSelectedBulkAction } from './export-selected-bulk-action';
import { ExportProductsButton, ImportProductsButton } from './import-products-dialog';

defineDashboardExtension({
    dataTables: [
        {
            // "Export selected" in the product-list bulk-actions menu. Exports the
            // exact rows the user ticked, so it respects any active search/filter
            // (the action-bar Export button's "current page" cannot see the filter).
            pageId: 'product-list',
            bulkActions: [{ order: 500, component: ExportSelectedBulkAction }],
        },
    ],
    actionBarItems: [
        {
            pageId: 'product-list',
            id: 'export-products',
            // No mount-time permission gate on purpose: requiresPermission has no
            // OR form, and a ReadCatalog gate would wrongly hide the button from a
            // (rare) UpdateCatalog-without-ReadCatalog user. The button self-gates
            // to CreateCatalog OR UpdateCatalog (usePermissions) and the resolver
            // enforces @Allow(CreateCatalog, UpdateCatalog) server-side.
            position: { itemId: 'rebuild-index-button', order: 'before' },
            component: () => <ExportProductsButton />,
        },
        {
            pageId: 'product-list',
            id: 'import-products',
            // Primary gate: catalog editors. The dialog further gates each action
            // (Update -> UpdateCatalog, Import new -> CreateCatalog) and the
            // resolvers enforce @Allow server-side.
            requiresPermission: 'UpdateCatalog',
            position: { itemId: 'rebuild-index-button', order: 'before' },
            component: () => <ImportProductsButton />,
        },
    ],
});
