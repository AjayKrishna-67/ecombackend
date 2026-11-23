import { ScheduledTask } from '@vendure/core';
import { AVAILABILITY_SWEEP_EVERY_MIN } from '../constants';
import { AvailabilityScheduleService } from '../services/availability-schedule.service';

/**
 * Worker-side tick for the whole plugin. Thin on purpose: logic placed here
 * cannot be unit-tested without booting the scheduler.
 *
 * Order matters. Reclaiming stuck runs first means a row abandoned by a killed
 * worker is eligible again in the same tick that would otherwise ignore it.
 * Materialising before executing means a rule created seconds ago, whose first
 * occurrence is already due, still fires now rather than a minute later.
 */
export const availabilitySweepTask = new ScheduledTask({
    id: 'availability-sweep',
    description: 'Applies scheduled product and collection enable/disable changes',
    schedule: cron => cron.every(AVAILABILITY_SWEEP_EVERY_MIN).minutes(),
    // The default is 60s, which equals the sweep interval -- a backlog on a
    // loaded database would be killed mid-tick every time.
    timeout: '5m',
    preventOverlap: true,
    execute: async ({ injector, scheduledContext }) => {
        const service = injector.get(AvailabilityScheduleService);
        await service.reclaimStuckRuns(scheduledContext);
        await service.materialise(scheduledContext);
        await service.executeDueRuns(scheduledContext);
    },
});
