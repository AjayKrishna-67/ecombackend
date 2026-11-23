import { addNavMenuItem } from '@vendure/admin-ui/core';

export default [
    addNavMenuItem(
        {
            id: 'customer-analytics',
            label: 'Customer Analytics',
            routerLink: ['/extensions/customer-analytics'],
            icon: 'bar-chart',
            // Predicate, not array: the nav-item requiresPermission type is
            // `string | (perms => boolean)` (no array overload). OR-fallback so the
            // owner sees the link before ReadCustomerAnalytics is assigned to a role.
            requiresPermission: userPermissions =>
                userPermissions.includes('ReadCustomerAnalytics') ||
                userPermissions.includes('SuperAdmin'),
        },
        'customers',
    ),
];
