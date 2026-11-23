import { ScheduledTask } from '@vendure/core';
import { ActivityLogPruneService } from '../services/activity-log-prune.service';

/**
 * Removes audit rows past the retention window (worker only, via
 * DefaultSchedulerPlugin).
 *
 * Without this the activity log becomes the largest table in the database inside
 * a year: every admin mutation writes a row and nothing ever deletes one.
 */
export const activityLogPruneTask = new ScheduledTask({
    id: 'admin-activity-log-prune',
    description: 'Deletes admin activity log rows past the retention window',
    schedule: cron => cron.every(1).days(),
    execute: async ({ injector }) => {
        return injector.get(ActivityLogPruneService).prune();
    },
});
