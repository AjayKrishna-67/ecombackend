import { RequestContext } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvailabilityScheduleRun } from '../../entities/availability-schedule-run.entity';
import { AvailabilitySchedule } from '../../entities/availability-schedule.entity';
import { AvailabilityScheduleService } from '../availability-schedule.service';

/**
 * Execution-path tests for the sweeper. The repo has no real-server e2e
 * harness, so TransactionalConnection is mocked in the same style as
 * channel-availability.service.spec: fake repositories, real service method.
 *
 * What is NOT covered here, deliberately: the conflict-ignoring insert in
 * materialise. Its correctness lives in a database unique index, so a mock
 * would only assert that we called the builder -- it could never prove the
 * duplicate was actually absorbed. That is verified by hand against MySQL.
 */

const NOW = new Date('2026-08-01T12:00:00.000Z');

interface FakeRunUpdate {
    criteria: Record<string, unknown>;
    values: Record<string, unknown>;
}

function makeRun(overrides: Partial<AvailabilityScheduleRun> = {}): AvailabilityScheduleRun {
    return {
        id: 1,
        dueAt: new Date(NOW.getTime() - 60_000),
        action: 'DISABLE',
        status: 'PENDING',
        attempts: 0,
        lastError: null,
        note: null,
        executedAt: null,
        schedule: {
            id: 10,
            targetType: 'Product',
            targetId: 42,
            channel: { id: 3 },
        },
        ...overrides,
    } as unknown as AvailabilityScheduleRun;
}

function makeService(run: AvailabilityScheduleRun, options: { claimed?: boolean; applier?: any } = {}) {
    const runUpdates: FakeRunUpdate[] = [];
    const applyAvailability =
        options.applier ?? vi.fn().mockResolvedValue({ outcome: 'APPLIED', note: null });

    const runRepo = {
        find: async () => [run],
        update: async (criteria: Record<string, unknown>, values: Record<string, unknown>) => {
            runUpdates.push({ criteria, values });
            // The claim is the update that conditions on status PENDING.
            if (criteria.status === 'PENDING') {
                return { affected: options.claimed === false ? 0 : 1 };
            }
            return { affected: 1 };
        },
    };

    const connection = {
        getRepository: (_ctx: RequestContext, entity: unknown) =>
            entity === AvailabilityScheduleRun ? runRepo : { find: async () => [] },
    };
    const requestContextService = { create: async () => ({ channelId: 3 }) as RequestContext };
    const applierRegistry = { applyAvailability };

    const service = new AvailabilityScheduleService(
        connection as any,
        {} as any,
        requestContextService as any,
        applierRegistry as any,
        // Only used when decorating list results with target names, which these
        // execution-path tests never reach.
        {} as any,
        {} as any,
        // Report sender: only reached by REPORT rules, and every rule in these
        // tests is an availability rule.
        {} as any,
        // Settings store: read on the REPORT path only, for the same reason.
        {} as any,
    );
    return { service, runUpdates, applyAvailability };
}

function finalStatus(runUpdates: FakeRunUpdate[]): unknown {
    return runUpdates[runUpdates.length - 1]?.values.status;
}

describe('AvailabilityScheduleService.executeDueRuns', () => {
    // executeDueRuns reads the wall clock via `new Date()`. Without freezing it,
    // fixtures built around a fixed NOW are evaluated against the real time and
    // every "due a minute ago" run reads as not-yet-due.
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('claims a due run, applies it and marks it DONE', async () => {
        const { service, runUpdates, applyAvailability } = makeService(makeRun());

        await service.executeDueRuns({} as RequestContext);

        expect(applyAvailability).toHaveBeenCalledTimes(1);
        expect(applyAvailability.mock.calls[0][0]).toMatchObject({
            targetType: 'Product',
            targetId: 42,
            shouldBeAvailable: false,
        });
        expect(runUpdates[0].values).toEqual({ status: 'RUNNING' });
        expect(finalStatus(runUpdates)).toBe('DONE');
    });

    it('translates an ENABLE action into shouldBeAvailable true', async () => {
        const { service, applyAvailability } = makeService(makeRun({ action: 'ENABLE' }));

        await service.executeDueRuns({} as RequestContext);

        expect(applyAvailability.mock.calls[0][0]).toMatchObject({ shouldBeAvailable: true });
    });

    it('skips a run past the grace window without touching the target', async () => {
        const staleRun = makeRun({ dueAt: new Date(NOW.getTime() - 5 * 60 * 60_000) });
        const { service, runUpdates, applyAvailability } = makeService(staleRun);

        await service.executeDueRuns({} as RequestContext);

        expect(applyAvailability).not.toHaveBeenCalled();
        expect(finalStatus(runUpdates)).toBe('SKIPPED');
    });

    it('does nothing when another process won the claim', async () => {
        const { service, runUpdates, applyAvailability } = makeService(makeRun(), { claimed: false });

        await service.executeDueRuns({} as RequestContext);

        expect(applyAvailability).not.toHaveBeenCalled();
        expect(runUpdates).toHaveLength(1);
        expect(runUpdates[0].values).toEqual({ status: 'RUNNING' });
    });

    it('records a NOOP with the explanatory note', async () => {
        const applier = vi
            .fn()
            .mockResolvedValue({ outcome: 'NOOP', note: 'Already unavailable; set by user #3.' });
        const { service, runUpdates } = makeService(makeRun(), { applier });

        await service.executeDueRuns({} as RequestContext);

        expect(runUpdates[runUpdates.length - 1].values).toMatchObject({
            status: 'NOOP',
            note: 'Already unavailable; set by user #3.',
        });
    });

    it('marks a run FAILED with the error message and an incremented attempt count', async () => {
        const applier = vi.fn().mockRejectedValue(new Error('Product with id 42 not found'));
        const { service, runUpdates } = makeService(makeRun({ attempts: 1 }), { applier });

        await service.executeDueRuns({} as RequestContext);

        expect(runUpdates[runUpdates.length - 1].values).toMatchObject({
            status: 'FAILED',
            lastError: 'Product with id 42 not found',
            attempts: 2,
        });
    });
});

describe('AvailabilityScheduleService validation', () => {
    function makeBareService() {
        const connection = { getRepository: () => ({ find: async () => [] }) };
        return new AvailabilityScheduleService(
            connection as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    }

    /**
     * A minimally valid availability rule. Every case below overrides one field
     * to make it invalid, so each test proves exactly the check it names --
     * without the target fields present, the kind-level "requires targetType and
     * targetId" check fires first and every assertion would pass for the wrong
     * reason.
     */
    const VALID_AVAILABILITY: Partial<AvailabilitySchedule> = {
        kind: 'AVAILABILITY',
        targetType: 'Product',
        targetId: 1,
        timezone: 'Asia/Kolkata',
    };

    function assertRejects(schedule: Partial<AvailabilitySchedule>, expectedFragment: string) {
        const service = makeBareService() as any;
        expect(() =>
            service.assertValidRule({ ...VALID_AVAILABILITY, ...schedule }),
        ).toThrowError(new RegExp(expectedFragment, 'i'));
    }

    it('rejects a ONE_OFF schedule missing runAt', () => {
        assertRejects({ mode: 'ONE_OFF', runAt: null, action: 'DISABLE' }, 'requires both runAt and action');
    });

    it('rejects a ONE_OFF schedule that also carries a cron pattern', () => {
        assertRejects(
            { mode: 'ONE_OFF', runAt: NOW, action: 'DISABLE', disableCron: '0 22 * * *' },
            'must not define cron patterns',
        );
    });

    it('rejects a RECURRING schedule with no pattern at all', () => {
        assertRejects(
            { mode: 'RECURRING', disableCron: null, enableCron: null },
            'requires disableCron or enableCron',
        );
    });

    it('rejects an unparseable cron pattern', () => {
        assertRejects({ mode: 'RECURRING', disableCron: 'not a cron' }, 'invalid cron pattern');
    });

    it('rejects an availability schedule carrying report fields', () => {
        // Rejected rather than ignored: an ignored recipients list reads, months
        // later, as "this rule notifies someone" when it never has.
        assertRejects(
            { mode: 'RECURRING', disableCron: '0 22 * * *', recipients: ['918056305724'] },
            'must not define report fields',
        );
    });

    it('rejects an availability schedule with no target', () => {
        assertRejects(
            { mode: 'RECURRING', disableCron: '0 22 * * *', targetType: null, targetId: null },
            'requires targetType and targetId',
        );
    });

    it('rejects a report schedule that also names a product target', () => {
        assertRejects(
            {
                kind: 'REPORT',
                mode: 'RECURRING',
                sendCron: '0 21 * * *',
                reportType: 'PURCHASE_LIST',
                dateRangeMode: 'TODAY',
                recipients: ['918056305724'],
                reportSellerId: '2',
            },
            'must not define a product or collection target',
        );
    });

    it('rejects a report schedule with no recipients', () => {
        assertRejects(
            {
                kind: 'REPORT',
                targetType: null,
                targetId: null,
                mode: 'RECURRING',
                sendCron: '0 21 * * *',
                reportType: 'PURCHASE_LIST',
                dateRangeMode: 'TODAY',
                recipients: [],
                reportSellerId: '2',
            },
            'requires at least one recipient',
        );
    });

    it('rejects a ONE_OFF report, because a one-off report is a button not a schedule', () => {
        assertRejects(
            {
                kind: 'REPORT',
                targetType: null,
                targetId: null,
                mode: 'ONE_OFF',
                sendCron: '0 21 * * *',
                reportType: 'PURCHASE_LIST',
                dateRangeMode: 'TODAY',
                recipients: ['918056305724'],
                reportSellerId: '2',
            },
            'must be RECURRING',
        );
    });

    it('accepts a complete report schedule', () => {
        const service = makeBareService() as any;
        expect(() =>
            service.assertValidRule({
                kind: 'REPORT',
                targetType: null,
                targetId: null,
                timezone: 'Asia/Kolkata',
                mode: 'RECURRING',
                sendCron: '0 21 * * *',
                reportType: 'PURCHASE_LIST',
                dateRangeMode: 'TODAY',
                recipients: ['918056305724'],
                // A report is scoped to a brand; its channels resolve at run time.
                reportSellerId: '2',
            }),
        ).not.toThrow();
    });

    it('rejects an unknown timezone', () => {
        assertRejects({ mode: 'RECURRING', disableCron: '0 22 * * *', timezone: 'Mars/Olympus' }, 'unknown timezone');
    });

    it('rejects an activeUntil that precedes activeFrom', () => {
        assertRejects(
            {
                mode: 'RECURRING',
                disableCron: '0 22 * * *',
                activeFrom: new Date('2026-09-01T00:00:00.000Z'),
                activeUntil: new Date('2026-08-01T00:00:00.000Z'),
            },
            'later than activeFrom',
        );
    });
});
