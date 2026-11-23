import { addNavMenuSection } from '@vendure/admin-ui/core';

export default [
    addNavMenuSection(
        {
            id: 'content-section',
            label: 'Content',
            items: [
                {
                    id: 'banner-ui',
                    label: 'Banners',
                    routerLink: ['/extensions/banner'],
                    icon: 'image',
                    requiresPermission: 'ReadBanner',
                },
            ],
        },
        'marketing'
    ),
];
