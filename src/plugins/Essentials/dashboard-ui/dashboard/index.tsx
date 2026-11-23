import { defineDashboardExtension } from '@vendure/dashboard';
import { CollectionVisibilityBadge } from './collection-visibility-badge';

defineDashboardExtension({
    dataTables: [
        {
            // The Collections list renders `isPrivate` with the default boolean
            // check/cross display. Registering a display component for that column
            // swaps it for a text badge. The dashboard keys display components as
            // `${pageId}_${blockId}_${field}`, and `blockId` defaults to 'list-table'.
            pageId: 'collection-list',
            displayComponents: [
                {
                    column: 'isPrivate',
                    component: CollectionVisibilityBadge,
                },
            ],
        },
    ],
});
