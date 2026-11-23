import { defineDashboardExtension } from '@vendure/dashboard';
import { LowStockWidget } from './low-stock-widget';

defineDashboardExtension({
    widgets: [
        {
            id: 'low-stock-widget',
            name: 'Low stock',
            component: LowStockWidget,
            defaultSize: { w: 6, h: 4.5 },
            minSize: { w: 4, h: 4 },
            requiresPermissions: ['ReadCatalog'],
        },
    ],
});
