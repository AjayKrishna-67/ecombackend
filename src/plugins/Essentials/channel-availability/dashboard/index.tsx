import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { BrandStorefrontListPage } from './brand-storefront-list';
import { ChannelEnabledBlock } from './channel-enabled-block';

defineDashboardExtension({
    routes: [
        {
            path: '/brand-storefronts',
            navMenuItem: {
                sectionId: 'settings',
                id: 'brand-storefronts',
                url: '/brand-storefronts',
                title: 'Brand Storefronts',
                // Built-in: channels=200, stock-locations=300 → 250 sits between.
                order: 250,
            },
            loader: () => ({ breadcrumb: 'Brand Storefronts' }),
            component: () => <BrandStorefrontListPage />,
        },
    ],
    pageBlocks: [
        {
            id: 'channel-enabled',
            title: 'Enabled',
            location: {
                pageId: 'channel-detail',
                column: 'side',
                position: { blockId: 'custom-fields', order: 'after' },
            },
            component: ({ context }) => <ChannelEnabledBlock context={context} />,
        },
    ],
    dataTables: [
        {
            // Add the `enabled` custom field to the Channels list table. The list
            // query doesn't fetch custom fields by default; extending it pulls the
            // field in and the dashboard auto-generates an "Enabled" column that
            // renders the boolean (checkmark), just like the Products list.
            pageId: 'channel-list',
            extendListDocument: `
                query {
                    channels {
                        items {
                            customFields {
                                enabled
                            }
                        }
                    }
                }
            `,
        },
    ],
});
