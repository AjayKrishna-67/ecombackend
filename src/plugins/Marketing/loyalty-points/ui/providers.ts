import { addNavMenuItem } from '@vendure/admin-ui/core';

export default [
    addNavMenuItem(
        {
            id: 'loyalty-points-config',
            label: 'Loyalty Points',
            routerLink: ['/extensions/loyalty-points'],
            icon: 'star',
            requiresPermission: 'LoyaltyPoints',
        },
        'content-section'  // Add to the Content section
    ),
];