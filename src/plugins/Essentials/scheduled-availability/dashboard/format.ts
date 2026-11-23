import cronstrue from 'cronstrue';
import {
    AvailabilityAction,
    AvailabilityRunStatus,
    AvailabilityScheduleRow,
    ScheduledReportType,
} from './queries';

/**
 * Presentation vocabulary for the whole feature, in one place.
 *
 * Kept separate from the components because the same sentence has to appear in
 * three places -- the list row, the detail header and the form preview -- and
 * three hand-written variants is how a "DISABLE at 7/30/2026, 12:38:00 PM" row
 * ends up meaning something subtly different from the detail page above it.
 */

/** Formats a UTC instant from the API in the viewer's own timezone. */
export function formatInstant(iso: string | null | undefined): string {
    return iso ? new Date(iso).toLocaleString() : '—';
}

/** Short form for table cells: no seconds, no year when it is this year. */
export function formatInstantShort(iso: string | null | undefined): string {
    if (!iso) {
        return '—';
    }
    const date = new Date(iso);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: sameYear ? undefined : 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

/** "in 3 hours" / "2 days ago". Absolute time still shown alongside. */
export function formatRelative(iso: string | null | undefined): string {
    if (!iso) {
        return '';
    }
    const deltaMs = new Date(iso).getTime() - Date.now();
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
        ['year', 365 * 24 * 3600_000],
        ['month', 30 * 24 * 3600_000],
        ['day', 24 * 3600_000],
        ['hour', 3600_000],
        ['minute', 60_000],
    ];
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, ms] of units) {
        if (Math.abs(deltaMs) >= ms) {
            return formatter.format(Math.round(deltaMs / ms), unit);
        }
    }
    return formatter.format(Math.round(deltaMs / 1000), 'second');
}

/**
 * The verb an occurrence performs.
 *
 * Centralised because four places rendered this as `action === 'DISABLE' ?
 * 'Hide' : 'Show'` — a binary that silently mislabels every SEND run as "Show".
 * A boolean expression over what is now a three-valued enum cannot fail loudly;
 * it just prints the wrong word.
 */
export function describeAction(action: AvailabilityAction | null | undefined): string {
    switch (action) {
        case 'DISABLE':
            return 'Hide';
        case 'ENABLE':
            return 'Show';
        case 'SEND':
            return 'Send';
        default:
            return '—';
    }
}

/**
 * Turns a 5-field cron pattern into a sentence.
 *
 * cronstrue rather than a hand-rolled parser: the interesting cases are the
 * ones nobody hand-rolls correctly -- step values, ranges, day-of-week names,
 * "last day of month". Falls back to the raw pattern rather than throwing,
 * because an unreadable schedule is better than a blank page.
 */
export function describeCron(pattern: string | null): string | null {
    if (!pattern) {
        return null;
    }
    try {
        return cronstrue.toString(pattern, { verbose: false, use24HourTimeFormat: false });
    } catch {
        return pattern;
    }
}

/**
 * One sentence describing what a rule does, in the admin's language.
 *
 * A recurring rule can carry both patterns, and the pair is the whole point: a
 * nightly close is only safe if something re-opens in the morning. Showing them
 * as one sentence makes a missing `enableCron` visible instead of implied.
 */
export function describeSchedule(row: AvailabilityScheduleRow): string {
    if (row.kind === 'REPORT') {
        const when = describeCron(row.sendCron);
        if (!when) {
            return 'Incomplete rule';
        }
        const count = row.recipients?.length ?? 0;
        const covering = row.dateRangeMode === 'YESTERDAY' ? "yesterday's" : "today's";
        // The brand is the report's scope, so it belongs in the one-line summary:
        // two rules identical but for their brand are otherwise indistinguishable
        // in the list.
        const brand = row.reportSellerName ? ` for ${row.reportSellerName}` : '';
        return `Send ${covering} purchase list${brand} ${lowerFirst(when)} to ${count} number${
            count === 1 ? '' : 's'
        } (${row.timezone})`;
    }
    if (row.mode === 'ONE_OFF') {
        if (!row.runAt || !row.action) {
            return 'Incomplete rule';
        }
        const verb = describeAction(row.action);
        return `${verb} once — ${formatInstant(row.runAt)}`;
    }
    const parts: string[] = [];
    const disable = describeCron(row.disableCron);
    const enable = describeCron(row.enableCron);
    if (disable) {
        parts.push(`Hide ${lowerFirst(disable)}`);
    }
    if (enable) {
        parts.push(`show again ${lowerFirst(enable)}`);
    }
    if (!parts.length) {
        return 'Incomplete rule';
    }
    return `${parts.join(', ')} (${row.timezone})`;
}

/** Warns when a recurring rule closes the target and never re-opens it. */
export function findScheduleWarning(row: AvailabilityScheduleRow): string | null {
    if (row.kind === 'REPORT') {
        return row.recipients?.length
            ? null
            : 'This report has no recipients, so every run will fail.';
    }
    if (row.mode !== 'RECURRING') {
        return null;
    }
    if (row.disableCron && !row.enableCron) {
        return 'This rule hides the target but never shows it again. Add a "show again" pattern unless that is intended.';
    }
    return null;
}

export interface RunStatusMeta {
    label: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';
    hint: string;
}

/**
 * Every status keeps its own weight.
 *
 * Collapsing them destroys the signal: SKIPPED (came due outside the grace
 * window) and NOOP (target was already in the wanted state) are not failures
 * and must not read as red. FAILED is the only status that means something
 * went wrong.
 */
export const RUN_STATUS_META: Record<AvailabilityRunStatus, RunStatusMeta> = {
    PENDING: {
        label: 'Waiting',
        variant: 'outline',
        hint: 'Materialised and waiting for its due time.',
    },
    RUNNING: { label: 'Running', variant: 'default', hint: 'Claimed by a worker right now.' },
    DONE: { label: 'Applied', variant: 'success', hint: 'The target was changed.' },
    NOOP: {
        label: 'No change',
        variant: 'secondary',
        hint: 'The target was already in the wanted state, so nothing was written.',
    },
    FAILED: { label: 'Failed', variant: 'destructive', hint: 'The apply threw. See the detail.' },
    SKIPPED: {
        label: 'Skipped',
        variant: 'warning',
        hint: 'Came due outside the grace window, so it was deliberately not applied.',
    },
    // Secondary, not warning: a weekly market closure is routine, and colouring
    // routine as warning is the same signal-destroying collapse this map's
    // comment warns about.
    CLOSED: {
        label: 'Market closed',
        variant: 'secondary',
        hint: 'The market was shut on this day, so no purchase list was sent.',
    },
    CANCELLED: {
        label: 'Cancelled',
        variant: 'outline',
        hint: 'The rule was paused or edited before this run came due.',
    },
};

/**
 * The rule's own state, which is not the same as its last run's state.
 *
 * A one-off that fired is finished, not idle -- calling it "Nothing scheduled"
 * (as the first version did) reads like a fault. Paused outranks everything,
 * because a paused rule will not fire whatever its history says.
 */
export function describeLifecycle(row: AvailabilityScheduleRow): RunStatusMeta {
    if (!row.isEnabled) {
        return { label: 'Paused', variant: 'outline', hint: 'This rule will not fire until resumed.' };
    }
    // Outranks "Scheduled" and "Completed" alike. A rule whose last run threw is
    // not healthy, and a recurring one will keep throwing every occurrence --
    // calling that "Completed" is how a broken rule stays broken for weeks.
    if (row.latestRun?.status === 'FAILED') {
        return {
            label: 'Needs attention',
            variant: 'destructive',
            hint: row.latestRun.lastError ?? 'The last run failed.',
        };
    }
    if (row.nextRun) {
        return {
            label: 'Scheduled',
            variant: 'default',
            hint: `Next: ${formatInstant(row.nextRun.dueAt)}`,
        };
    }
    if (row.mode === 'ONE_OFF' && row.latestRun) {
        return { label: 'Completed', variant: 'secondary', hint: 'This one-off rule has run.' };
    }
    if (row.mode === 'RECURRING') {
        return {
            label: 'Active',
            variant: 'default',
            hint: 'Occurrences are materialised up to 48 hours ahead by the sweep.',
        };
    }
    return { label: 'Pending sweep', variant: 'outline', hint: 'Not yet materialised.' };
}

/**
 * True when a rule has nothing left to do and never will again.
 *
 * A one-off that has already fired has no future occurrence to materialise, so
 * pausing and resuming it are both no-ops. The pause switch is disabled in that
 * state rather than left looking live -- a control that cannot change anything
 * should not invite a click.
 *
 * Deliberately not folded into `describeLifecycle`: that answers "what should
 * the badge say", and a FAILED last run outranks Completed there. This answers
 * "can this rule still act", which stays true even when the badge reads
 * "Needs attention".
 */
export function isSpentOneOff(row: AvailabilityScheduleRow): boolean {
    return row.mode === 'ONE_OFF' && !!row.latestRun && !row.nextRun;
}

/** Channel codes are slugs; the default channel's is not a name at all. */
export function formatChannelCode(code: string): string {
    return code === '__default_channel__' ? 'Default channel' : code;
}

/**
 * Human label for a report kind.
 *
 * Falls back to "Report" rather than to the raw enum: a new report type shipped
 * server-side before the Dashboard knows about it should read as a report, not
 * as SOME_NEW_ENUM.
 */
export function describeReportType(reportType: ScheduledReportType | null | undefined): string {
    return reportType === 'PURCHASE_LIST' ? 'Purchase list' : 'Report';
}

/** Target label that degrades gracefully when the product was deleted. */
export function describeTarget(row: AvailabilityScheduleRow): string {
    return row.targetName ?? `${row.targetType} #${String(row.targetId)} (deleted)`;
}

function lowerFirst(value: string): string {
    return value.charAt(0).toLowerCase() + value.slice(1);
}
