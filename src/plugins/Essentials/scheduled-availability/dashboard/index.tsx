import { defineDashboardExtension } from '@vendure/dashboard';
import React from 'react';
import { AvailabilityScheduleDetailPage } from './availability-schedule-detail';
import { AvailabilityScheduleListPage } from './availability-schedule-list';

defineDashboardExtension({
    routes: [
        {
            path: '/availability-schedules',
            navMenuItem: {
                sectionId: 'system',
                id: 'availability-schedules',
                url: '/availability-schedules',
                title: 'Scheduled Availability',
                order: 400,
            },
            loader: () => ({ breadcrumb: 'Scheduled Availability' }),
            // The route object is handed to the component by the extension router.
            // `ListPage` needs it to read and write its list state (page, sort,
            // filters) as URL search params, which is what makes a filtered view
            // shareable and survive a reload.
            component: route => <AvailabilityScheduleListPage route={route} />,
        },
        {
            // `$id` is TanStack Router's path-param syntax, matching the other
            // detail routes in this project (tags, postal-codes, addon-groups).
            // Also serves /availability-schedules/new, where the component
            // renders the create form instead of a detail view.
            path: '/availability-schedules/$id',
            loader: ({ params }: { params: { id: string } }) => ({
                breadcrumb: params.id === 'new' ? 'New schedule' : 'Schedule',
            }),
            component: () => <AvailabilityScheduleDetailPage />,
        },
    ],
});
