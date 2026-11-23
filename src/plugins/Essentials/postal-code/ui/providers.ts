import { addNavMenuItem } from '@vendure/admin-ui/core';

export default [
    addNavMenuItem(
        {
            id: 'postal-code-ui',
            label: 'Postal Codes',
            routerLink: ['/extensions/postal-code'],
            icon: 'map-marker',
            requiresPermission: 'ReadPostalCode',
        },
        'settings',
        'countries'
    ),
];

