import { ScheduledTask } from '@vendure/core';
import { PriceUpdateService } from '../price-update.plugin';

// TEST MODE: set PRICE_SYNC_DRAIN_EVERY_MIN=1 to drain every minute. Default 10.
const everyMinutes = Number(process.env.PRICE_SYNC_DRAIN_EVERY_MIN ?? '10');

/**
 * Drains the durable price-sync backlog on a cron cadence (worker only, via
 * DefaultSchedulerPlugin). Each run is health-gated inside `drainQueue`: if the
 * DB is slow or the pool is tight, it skips this tick and retries next time, so
 * the drain can never repeat the bulk-update outage.
 */
export const priceSyncDrainTask = new ScheduledTask({
    id: 'price-sync-drain',
    description: 'Health-gated background drain of pending order price updates',
    schedule: cron => cron.every(everyMinutes).minutes(),
    execute: async ({ injector }) => {
        return injector.get(PriceUpdateService).drainQueue();
    },
});
