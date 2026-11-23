import { ScheduledTask } from '@vendure/core';
import { AbandonedCartService } from '../services/abandoned-cart.service';

// TEST MODE: set ABANDONED_CART_SWEEP_EVERY_MIN=1 to sweep every minute. Default 30.
const everyMinutes = Number(process.env.ABANDONED_CART_SWEEP_EVERY_MIN ?? '30');

/**
 * Runs every 30 minutes on the worker (via DefaultSchedulerPlugin). Delegates to the
 * service, which iterates channels and nudges eligible abandoned carts.
 */
export const abandonedCartSweepTask = new ScheduledTask({
    id: 'abandoned-cart-sweep',
    description: 'Sends staged WhatsApp nudges for abandoned carts',
    schedule: cron => cron.every(everyMinutes).minutes(),
    execute: async ({ injector, scheduledContext }) => {
        await injector.get(AbandonedCartService).sweep(scheduledContext);
    },
});
