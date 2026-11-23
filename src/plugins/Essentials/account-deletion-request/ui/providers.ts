import {
    registerDashboardWidget,
    setDashboardWidgetLayout,
} from '@vendure/admin-ui/core';
import { CustomerDeletionWidgetComponent } from './customer-deletion-widget';

export default [
    registerDashboardWidget('customer-deletion-requests', {
        title: 'Customer Deletion Requests',
        supportedWidths: [4, 6, 8, 12],
        loadComponent: () => Promise.resolve(CustomerDeletionWidgetComponent),
    }),
    setDashboardWidgetLayout([
        { id: 'welcome', width: 12 },
        { id: 'orderSummary', width: 6 },
        { id: 'reviews', width: 6 },
        { id: 'stock-levels', width: 12 },
        { id: 'customer-deletion-requests', width: 12 },
        { id: 'latestOrders', width: 12 },
    ]),
];
