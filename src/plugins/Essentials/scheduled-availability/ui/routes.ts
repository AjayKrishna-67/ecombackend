import { registerRouteComponent } from '@vendure/admin-ui/core';
import { AvailabilityScheduleListComponent } from './availability-schedule-list.component';

/**
 * One route, no detail screen.
 *
 * The Angular surface is deliberately read-only: creating and editing a rule
 * needs the cron builder, the channel-scoped target picker and the live
 * occurrence preview, all of which already exist in the React Dashboard. A
 * second, thinner editor would be a second place for those rules to drift.
 */
export default [
    registerRouteComponent({
        component: AvailabilityScheduleListComponent,
        path: '',
        title: 'Scheduled Availability',
        breadcrumb: [
            { label: 'Scheduled Availability', link: ['/extensions', 'scheduled-availability'] },
        ],
    }),
];
