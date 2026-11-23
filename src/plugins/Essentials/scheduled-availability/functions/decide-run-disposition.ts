const MILLISECONDS_PER_MINUTE = 60_000;

export type RunDisposition = 'RUN' | 'SKIP_STALE';

interface DecideRunDispositionArgs {
    dueAt: Date;
    now: Date;
    graceMinutes: number;
}

/**
 * Decides whether a claimed run should still be applied.
 *
 * If the worker was down overnight, a 22:00 "disable" surfaces at 03:00. Firing
 * it then would close a storefront at an hour no human intended, so anything
 * older than the grace window is deliberately skipped. Making the catch-up
 * policy an explicit, testable decision beats letting it fall out of whenever
 * the worker happened to restart.
 *
 * A run that is not yet due also returns SKIP_STALE: it should never have been
 * claimed, and surfacing that as a skipped row makes the mistake visible
 * instead of applying a change early and silently.
 */
export function decideRunDisposition({
    dueAt,
    now,
    graceMinutes,
}: DecideRunDispositionArgs): RunDisposition {
    const ageMs = now.getTime() - dueAt.getTime();
    if (ageMs < 0) {
        return 'SKIP_STALE';
    }
    return ageMs <= graceMinutes * MILLISECONDS_PER_MINUTE ? 'RUN' : 'SKIP_STALE';
}
