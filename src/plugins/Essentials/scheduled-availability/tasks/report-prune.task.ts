import { Logger, ScheduledTask } from '@vendure/core';
import { REPORT_LOCAL_RETENTION_DAYS, REPORT_PRUNE_HOUR } from '../constants';
import { ReportSenderService } from '../services/report-sender.service';

const loggerCtx = 'ReportPrune';

/**
 * Deletes local report PDFs older than the retention window.
 *
 * A separate task rather than another step inside availability-sweep: that one
 * ticks every minute, and a filesystem walk on every tick is pure waste for a
 * directory that only changes when a report is sent. Separating them also keeps
 * one failure domain per task -- an unreadable directory cannot delay the sweep
 * that actually enables and disables products.
 *
 * Only the local debug copies are pruned. The delivered documents live in object
 * storage and are expired by a bucket lifecycle rule, because deleting those is
 * a different decision with a different blast radius: a WhatsApp message whose
 * attachment has been removed shows the recipient a dead link.
 */
export const reportPruneTask = new ScheduledTask({
    id: 'report-prune',
    description: 'Deletes locally-saved report PDFs older than the retention window',
    schedule: cron => cron.everyDayAt(REPORT_PRUNE_HOUR),
    // Well above the real cost (a readdir plus a handful of unlinks), but the
    // directory is only bounded by how long pruning has been broken -- a first
    // run against months of accumulation should finish rather than time out.
    timeout: '5m',
    preventOverlap: true,
    execute: async ({ injector }) => {
        const removed = await injector
            .get(ReportSenderService)
            .pruneLocalCopies(REPORT_LOCAL_RETENTION_DAYS);
        // Logged even at zero: silence here is indistinguishable from a task that
        // never ran, which is exactly the question asked when a disk fills up.
        Logger.info(
            `Report prune finished: ${removed} file(s) removed ` +
                `(retention ${REPORT_LOCAL_RETENTION_DAYS} day(s))`,
            loggerCtx,
        );
    },
});
