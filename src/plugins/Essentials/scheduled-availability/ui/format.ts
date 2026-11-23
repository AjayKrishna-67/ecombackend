/**
 * Presentation helpers for the Angular schedule list.
 *
 * A deliberate re-implementation of the React Dashboard's `dashboard/format.ts`
 * rather than a shared module: that file imports `cronstrue` and returns shadcn
 * badge variants, neither of which exists in the Angular build. `cronstrue` is
 * present in node_modules only transitively (nothing declares it in
 * package.json), and ui-devkit generates its own package.json for the compiled
 * admin app -- so importing it here would build locally and fail on a clean
 * install. The cron describer below covers the three shapes the Dashboard's own
 * cron builder can emit and echoes anything else verbatim, which is exactly what
 * cronstrue's error path did anyway.
 */

/** Colour vocabulary of `<vdr-chip>`. Narrower than the Dashboard's variants. */
export type ChipColor = 'success' | 'error' | 'warning' | undefined;

export interface ScheduleRunLike {
    status: string;
    /** Which direction this occurrence applied. SEND on report runs. */
    action?: string | null;
    dueAt?: string | null;
    executedAt?: string | null;
    lastError?: string | null;
    note?: string | null;
    attempts?: number | null;
}

export interface ScheduleLike {
    kind: string;
    mode: string;
    isEnabled: boolean;
    label?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    targetName?: string | null;
    runAt?: string | null;
    action?: string | null;
    disableCron?: string | null;
    enableCron?: string | null;
    sendCron?: string | null;
    reportType?: string | null;
    /** REPORT only. The brand; its channels resolve server-side on each read. */
    reportSellerId?: string | null;
    reportSellerName?: string | null;
    reportChannels?: Array<{ id: string; code: string }> | null;
    recipients?: string[] | null;
    dateRangeMode?: string | null;
    timezone: string;
    latestRun?: ScheduleRunLike | null;
    nextRun?: ScheduleRunLike | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Renders a 5-field cron pattern as a sentence.
 *
 * Handles only the patterns the schedule form can produce -- fixed minute and
 * hour, wildcard month, and then daily / chosen-weekdays / chosen-month-day.
 * Anything else (ranges, steps, hand-typed advanced patterns) falls through to
 * the raw string, which is still readable and never wrong.
 */
export function describeCron(pattern: string | null | undefined): string {
    if (!pattern) {
        return '';
    }
    const fields = pattern.trim().split(/\s+/);
    if (fields.length !== 5) {
        return pattern;
    }
    const [minute, hour, monthDay, month, weekDay] = fields;
    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') {
        return pattern;
    }
    const at = `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
    if (monthDay === '*' && weekDay === '*') {
        return `Every day at ${at}`;
    }
    if (monthDay === '*' && /^[0-6](,[0-6])*$/.test(weekDay)) {
        const days = weekDay
            .split(',')
            .map(day => DAY_NAMES[Number(day)])
            .join(', ');
        return `At ${at} on ${days}`;
    }
    if (/^\d+$/.test(monthDay) && weekDay === '*') {
        return `At ${at} on day ${Number(monthDay)} of every month`;
    }
    return pattern;
}

/** Lower-cases the first letter so a sentence can be embedded mid-phrase. */
function lowerFirst(text: string): string {
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** '__default_channel__' is an implementation detail; nobody calls it that. */
export function formatChannelCode(code: string | null | undefined): string {
    return code === '__default_channel__' ? 'Default channel' : code ?? '—';
}

/** Three-valued on purpose: a DISABLE/else shortcut mislabels every SEND run. */
export function describeAction(action: string | null | undefined): string {
    if (action === 'DISABLE') {
        return 'Hide';
    }
    if (action === 'ENABLE') {
        return 'Show';
    }
    if (action === 'SEND') {
        return 'Send';
    }
    return '—';
}

/** One sentence saying what this rule actually does, in the admin's language. */
export function describeSchedule(row: ScheduleLike): string {
    if (row.kind === 'REPORT') {
        const when = describeCron(row.sendCron);
        if (!when) {
            return 'Incomplete rule';
        }
        const brand = row.reportSellerName ? ` for ${row.reportSellerName}` : '';
        const day = row.dateRangeMode === 'YESTERDAY' ? "yesterday's" : "today's";
        const count = row.recipients?.length ?? 0;
        return `Send ${day} purchase list${brand} ${lowerFirst(when)} to ${count} number(s) (${row.timezone})`;
    }
    if (row.mode === 'ONE_OFF') {
        if (!row.runAt || !row.action) {
            return 'Incomplete rule';
        }
        return `${describeAction(row.action)} once — ${new Date(row.runAt).toLocaleString()}`;
    }
    const parts: string[] = [];
    if (row.disableCron) {
        parts.push(`Hide ${lowerFirst(describeCron(row.disableCron))}`);
    }
    if (row.enableCron) {
        parts.push(`show again ${lowerFirst(describeCron(row.enableCron))}`);
    }
    return parts.length ? `${parts.join(', ')} (${row.timezone})` : 'Incomplete rule';
}

export interface Lifecycle {
    label: string;
    color: ChipColor;
    hint: string;
}

/**
 * The rule's health, as one badge.
 *
 * Precedence matters and is not alphabetical: a paused rule is paused whatever
 * its history, and a failed last run outranks a healthy-looking next run --
 * reordering these silently badges a broken recurring rule as fine.
 */
export function describeLifecycle(row: ScheduleLike): Lifecycle {
    if (!row.isEnabled) {
        return { label: 'Paused', color: undefined, hint: 'This rule will not fire until resumed.' };
    }
    if (row.latestRun?.status === 'FAILED') {
        return {
            label: 'Needs attention',
            color: 'error',
            hint: row.latestRun.lastError ?? 'The last run failed.',
        };
    }
    if (row.nextRun?.dueAt) {
        return {
            label: 'Scheduled',
            color: 'success',
            hint: `Next: ${new Date(row.nextRun.dueAt).toLocaleString()}`,
        };
    }
    if (row.mode === 'ONE_OFF' && row.latestRun) {
        return { label: 'Completed', color: undefined, hint: 'This one-off rule has run.' };
    }
    if (row.mode === 'RECURRING') {
        return {
            label: 'Active',
            color: 'success',
            hint: 'Occurrences are materialised up to 48 hours ahead by the sweep.',
        };
    }
    return { label: 'Pending sweep', color: undefined, hint: 'Not yet materialised.' };
}

/**
 * Run outcome colouring.
 *
 * SKIPPED and NOOP are deliberately kept out of the red band -- neither is a
 * failure, and coding them as one trains admins to ignore the colour.
 */
export function runStatusColor(status: string | null | undefined): ChipColor {
    if (status === 'DONE') {
        return 'success';
    }
    if (status === 'FAILED') {
        return 'error';
    }
    if (status === 'SKIPPED') {
        return 'warning';
    }
    return undefined;
}

/** Admin-facing wording for a run status. The raw enum leaks implementation. */
export function runStatusLabel(status: string | null | undefined): string {
    switch (status) {
        case 'PENDING':
            return 'Waiting';
        case 'RUNNING':
            return 'Running';
        case 'DONE':
            return 'Applied';
        case 'NOOP':
            return 'No change';
        case 'FAILED':
            return 'Failed';
        case 'SKIPPED':
            return 'Skipped';
        case 'CLOSED':
            return 'Market closed';
        case 'CANCELLED':
            return 'Cancelled';
        default:
            return '—';
    }
}

/**
 * The one thing about this rule that should worry someone, or null.
 *
 * Surfaced on the list rather than only on a detail screen because both cases
 * are silent failures: nothing errors, the rule simply does nothing useful.
 */
export function findScheduleWarning(row: ScheduleLike): string | null {
    if (row.kind === 'REPORT' && !(row.recipients?.length ?? 0)) {
        return 'This report has no recipients, so every run will fail.';
    }
    if (row.mode === 'RECURRING' && row.disableCron && !row.enableCron) {
        return 'This rule hides the target but never shows it again. Add a "show again" pattern unless that is intended.';
    }
    return null;
}

/** List's primary label. REPORT rows have no target to name, so they borrow one. */
export function describeRowName(row: ScheduleLike): string {
    if (row.label) {
        return row.label;
    }
    if (row.kind === 'REPORT') {
        return 'Purchase list report';
    }
    return row.targetName ?? `${row.targetType} #${row.targetId} (deleted)`;
}
