import { defineDashboardExtension } from '@vendure/dashboard';
import { CustomerDeletionWidget } from './customer-deletion-widget';

defineDashboardExtension({
    widgets: [
        {
            id: 'customer-deletion-requests',
            name: 'Customer Deletion Requests',
            component: CustomerDeletionWidget,
            defaultSize: { w: 12, h: 5 },
            minSize: { w: 6, h: 4 },
            requiresPermissions: ['ReadCustomer'],
        },
    ],
});
