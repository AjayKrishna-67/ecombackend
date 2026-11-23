import { Cron } from 'croner';
import { AvailabilityAction, AvailabilityScheduleMode, ScheduleKind } from '../constants';

/** Safety stop: a malformed pattern must not spin the sweep forever. */
const MAX_OCCURRENCES_PER_PATTERN = 1000;

/**
 * The scheduling fields of a rule, structurally. Deliberately not the TypeORM
 * entity: keeping this function free of entity imports avoids a module cycle
 * and lets the tests build plain objects. An AvailabilitySchedule satisfies it.
 */
export interface OccurrenceRule {
    /**
     * Defaults to AVAILABILITY when absent so every existing caller -- and every
     * existing test -- keeps its meaning without being rewritten.
     */
    kind?: ScheduleKind;
    mode: AvailabilityScheduleMode;
    runAt: Date | null;
    action: AvailabilityAction | null;
    disableCron: string | null;
    enableCron: string | null;
    /** REPORT only. A report has one pattern, not a hide/show pair. */
    sendCron?: string | null;
    timezone: string;
    activeFrom: Date | null;
    activeUntil: Date | null;
    isEnabled: boolean;
}

export interface AvailabilityOccurrence {
    dueAt: Date;
    action: AvailabilityAction;
}

interface ComputeOccurrencesArgs {
    rule: OccurrenceRule;
    from: Date;
    to: Date;
}

/**
 * Expands a rule into the concrete instants it fires within (from, to].
 *
 * Recurring patterns are read in the rule's IANA timezone and returned as UTC
 * Date objects, which is what the run rows store. One-off rules ignore the
 * lower bound: a rule created a minute after its own `runAt` must still
 * materialise, and whether it is too stale to apply is a separate decision
 * made by `decideRunDisposition` at execution time.
 */
export function computeOccurrences({ rule, from, to }: ComputeOccurrencesArgs): AvailabilityOccurrence[] {
    if (!rule.isEnabled) {
        return [];
    }
    const occurrences =
        rule.mode === 'ONE_OFF' ? expandOneOff(rule, to) : expandRecurring(rule, from, to);

    return occurrences
        .filter(occurrence => isWithinActiveBounds(occurrence.dueAt, rule))
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

function expandOneOff(rule: OccurrenceRule, to: Date): AvailabilityOccurrence[] {
    if (!rule.runAt || !rule.action || rule.runAt > to) {
        return [];
    }
    return [{ dueAt: rule.runAt, action: rule.action }];
}

function expandRecurring(rule: OccurrenceRule, from: Date, to: Date): AvailabilityOccurrence[] {
    // A report has a single pattern and a single action. Expanding its sendCron
    // through the same machinery means the grace window, the stuck-run reclaim
    // and the run history all apply to it unchanged.
    if (rule.kind === 'REPORT') {
        return expandPattern(rule.sendCron ?? null, rule.timezone, 'SEND', from, to);
    }
    return [
        ...expandPattern(rule.disableCron, rule.timezone, 'DISABLE', from, to),
        ...expandPattern(rule.enableCron, rule.timezone, 'ENABLE', from, to),
    ];
}

function expandPattern(
    pattern: string | null,
    timezone: string,
    action: AvailabilityAction,
    from: Date,
    to: Date,
): AvailabilityOccurrence[] {
    if (!pattern) {
        return [];
    }
    // No callback is passed, so croner never schedules anything -- this is a
    // pure pattern calculator, not a running job.
    const cron = new Cron(pattern, { timezone });
    const occurrences: AvailabilityOccurrence[] = [];
    let cursor: Date | null = from;
    while (occurrences.length < MAX_OCCURRENCES_PER_PATTERN) {
        cursor = cron.nextRun(cursor);
        if (!cursor || cursor > to) {
            break;
        }
        occurrences.push({ dueAt: cursor, action });
    }
    return occurrences;
}

function isWithinActiveBounds(dueAt: Date, rule: OccurrenceRule): boolean {
    if (rule.activeFrom && dueAt < rule.activeFrom) {
        return false;
    }
    if (rule.activeUntil && dueAt > rule.activeUntil) {
        return false;
    }
    return true;
}
