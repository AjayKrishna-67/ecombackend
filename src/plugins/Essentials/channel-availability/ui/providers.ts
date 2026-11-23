import { addNavMenuItem } from '@vendure/admin-ui/core';

export default [
    addNavMenuItem(
        {
            id: 'brand-storefronts',
            label: 'Brand Storefronts',
            routerLink: ['/extensions/brand-storefronts'],
            icon: 'store',
            requiresPermission: 'ReadBrandStorefront',
        },
        'settings',
    ),
];
