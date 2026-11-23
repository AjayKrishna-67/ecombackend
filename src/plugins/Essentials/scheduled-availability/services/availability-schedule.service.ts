import { Injectable } from '@nestjs/common';
import {
    Administrator,
    Asset,
    Channel,
    CollectionService,
    EntityNotFoundError,
    ID,
    ListQueryBuilder,
    ListQueryOptions,
    Logger,
    PaginatedList,
    Permission,
    ProductService,
    RequestContext,
    RequestContextService,
    SettingsStoreService,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { DEFAULT_CHANNEL_CODE } from '@vendure/common/lib/shared-constants';
import { Cron } from 'croner';
import { In, LessThanOrEqual } from 'typeorm';
import {
    DEFAULT_PREVIEW_COUNT,
    DEFAULT_SCHEDULE_KIND,
    DEFAULT_SCHEDULE_TIMEZONE,
    MARKET_CLOSURE_SETTING_KEY,
    MATERIALISATION_HORIZON_HOURS,
    STALE_RUN_GRACE_MINUTES,
    STUCK_RUN_RECLAIM_MINUTES,
} from '../constants';
import {
    DEFAULT_MARKET_CLOSURE_CONFIG,
    MarketClosureConfig,
} from '../functions/market-closure';
import { ReportSenderService } from './report-sender.service';
import { AvailabilityScheduleRun } from '../entities/availability-schedule-run.entity';
import { AvailabilitySchedule } from '../entities/availability-schedule.entity';
import { AvailabilityTargetType } from '../constants';
import {
    AvailabilityOccurrence,
    computeOccurrences,
    OccurrenceRule,
} from '../functions/compute-occurrences';
import { decideRunDisposition } from '../functions/decide-run-disposition';
import { CreateAvailabilityScheduleInput, UpdateAvailabilityScheduleInput } from '../types';
import { TargetApplierRegistry } from './target-applier.registry';

const loggerCtx = 'ScheduledAvailability';

/** Rows returned by the target picker. Enough to show, not enough to leak. */
export interface AvailabilityTargetSummary {
    id: ID;
    name: string;
    asset: Asset | null;
}

/** Type-ahead results per query. Larger lists are scrolled, not read. */
const TARGET_SEARCH_LIMIT = 20;

/** Bounds one tick's work so a large backlog cannot exceed the task timeout. */
const MAX_RUNS_PER_TICK = 200;

const MILLISECONDS_PER_HOUR = 3_600_000;

/** Preview looks far enough ahead that weekly and monthly patterns still fill. */
const PREVIEW_HORIZON_DAYS = 90;

/**
 * Owns availability schedules: the rules an admin authors, the runs those rules
 * expand into, and the execution of runs that have come due.
 *
 * Rules are intent and stay editable. Runs are facts: once DONE, NOOP, FAILED
 * or SKIPPED they are never rewritten, because they are the only record of what
 * the system actually did.
 */
@Injectable()
export class AvailabilityScheduleService {
    constructor(
        private connection: TransactionalConnection,
        private listQueryBuilder: ListQueryBuilder,
        private requestContextService: RequestContextService,
        private applierRegistry: TargetApplierRegistry,
        private productService: ProductService,
        private collectionService: CollectionService,
        private reportSender: ReportSenderService,
        private settingsStore: SettingsStoreService,
    ) {}

    /**
     * Lists the active channel's schedules.
     *
     * Channel-aware by the context, not by an argument: a rule acts on exactly
     * one channel's catalogue, so showing another channel's rules would offer
     * actions the admin cannot take from where they are standing.
     *
     * `allChannels` widens that to every channel the caller may administer -- a
     * read-only overview, because a rule is still only mutatable from its own
     * channel (see `findOne`). Without it a schedule created on Coimbatore is
     * invisible from anywhere else, and the only way to discover one is to visit
     * each channel in turn.
     */
    async findAll(
        ctx: RequestContext,
        options?: ListQueryOptions<AvailabilitySchedule>,
        allChannels = false,
    ): Promise<PaginatedList<AvailabilitySchedule>> {
        const channelIds = allChannels ? this.administrableChannelIds(ctx) : [ctx.channelId];
        const [items, totalItems] = await this.listQueryBuilder
            .build(AvailabilitySchedule, options, {
                ctx,
                relations: ['channel', 'createdByAdmin'],
                where: { channel: { id: In(channelIds as any[]) } },
            })
            .getManyAndCount();
        await this.decorate(ctx, items);
        return { items, totalItems };
    }

    /**
     * Channels this caller holds SuperAdmin on.
     *
     * Intersected rather than "all channels", because `recipients` holds real
     * staff phone numbers: a Madurai-only admin flipping this on must not be
     * handed Coimbatore's. Every operation on this API is SuperAdmin-only, so
     * that is the permission to intersect on -- reading the session's own
     * channel grants, not re-querying roles.
     *
     * Falls back to the active channel when the session carries no grants at
     * all (an internal or system context), which keeps the previous behaviour
     * rather than silently returning everything.
     */
    private administrableChannelIds(ctx: RequestContext): ID[] {
        const grants = ctx.session?.user?.channelPermissions ?? [];
        const ids = grants
            .filter(grant => grant.permissions.includes(Permission.SuperAdmin))
            .map(grant => grant.id);
        return ids.length ? ids : [ctx.channelId];
    }

    /**
     * One schedule, scoped to the active channel.
     *
     * The channel check is here rather than at each call site because
     * `assertFound` funnels update, delete, setEnabled and runNow through this
     * method -- so a rule belonging to another channel is invisible *and*
     * unmutatable from the current one, in a single place.
     */
    async findOne(ctx: RequestContext, id: ID): Promise<AvailabilitySchedule | undefined> {
        const schedule = await this.connection
            .getRepository(ctx, AvailabilitySchedule)
            .findOne({ where: { id }, relations: { channel: true, createdByAdmin: true } });
        if (!schedule || String(schedule.channel?.id) !== String(ctx.channelId)) {
            return undefined;
        }
        await this.decorate(ctx, [schedule]);
        return schedule;
    }

    findRuns(
        ctx: RequestContext,
        scheduleId: ID,
        options?: ListQueryOptions<AvailabilityScheduleRun>,
    ): Promise<PaginatedList<AvailabilityScheduleRun>> {
        return this.listQueryBuilder
            .build(AvailabilityScheduleRun, options, {
                ctx,
                where: { schedule: { id: scheduleId } },
                orderBy: { dueAt: 'DESC' },
            })
            .getManyAndCount()
            .then(([items, totalItems]) => ({ items, totalItems }));
    }

    async create(
        ctx: RequestContext,
        input: CreateAvailabilityScheduleInput,
    ): Promise<AvailabilitySchedule> {
        const kind = input.kind ?? DEFAULT_SCHEDULE_KIND;
        const schedule = new AvailabilitySchedule({
            kind,
            targetType: kind === 'REPORT' ? null : input.targetType ?? null,
            targetId: kind === 'REPORT' ? null : input.targetId ?? null,
            sendCron: input.sendCron ?? null,
            reportType: input.reportType ?? null,
            reportSellerId: input.reportSellerId ?? null,
            recipients: input.recipients?.map(String) ?? null,
            dateRangeMode: input.dateRangeMode ?? null,
            channel: { id: input.channelId } as Channel,
            mode: input.mode,
            runAt: input.runAt ?? null,
            action: input.action ?? null,
            disableCron: input.disableCron ?? null,
            enableCron: input.enableCron ?? null,
            timezone: input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
            activeFrom: input.activeFrom ?? null,
            activeUntil: input.activeUntil ?? null,
            isEnabled: true,
            label: input.label ?? null,
            createdByAdmin: ctx.activeUserId
                ? await this.findAdministratorForUser(ctx, ctx.activeUserId)
                : null,
        });
        this.assertValidRule(schedule);
        const channel = await this.connection
            .getRepository(ctx, Channel)
            .findOneOrFail({ where: { id: input.channelId as any } });
        // Only availability rules point at an entity. A report has no target to
        // verify -- its "target" is a query, which cannot be missing.
        if (schedule.kind !== 'REPORT') {
            await this.assertTargetExists(schedule.targetType!, schedule.targetId!, channel);
        }
        const saved = await this.connection.getRepository(ctx, AvailabilitySchedule).save(schedule);
        // Materialise immediately so a rule whose first occurrence is minutes
        // away is visible -- and executable -- without waiting for a sweep.
        await this.materialise(ctx, saved);
        // The mutation returns an AvailabilitySchedule, and that type advertises
        // targetName, targetAsset, latestRun and nextRun. Returning the raw saved
        // row leaves all four null, so a client that renders the mutation result
        // shows a blank rule until something refetches it.
        await this.decorate(ctx, [saved]);
        return saved;
    }

    async update(
        ctx: RequestContext,
        input: UpdateAvailabilityScheduleInput,
    ): Promise<AvailabilitySchedule> {
        const repository = this.connection.getRepository(ctx, AvailabilitySchedule);
        const schedule = await this.assertFound(ctx, input.id);
        Object.assign(schedule, {
            targetType: input.targetType ?? schedule.targetType,
            targetId: input.targetId ?? schedule.targetId,
            mode: input.mode ?? schedule.mode,
            runAt: input.runAt !== undefined ? input.runAt : schedule.runAt,
            action: input.action !== undefined ? input.action : schedule.action,
            disableCron: input.disableCron !== undefined ? input.disableCron : schedule.disableCron,
            enableCron: input.enableCron !== undefined ? input.enableCron : schedule.enableCron,
            sendCron: input.sendCron !== undefined ? input.sendCron : schedule.sendCron,
            reportType: input.reportType !== undefined ? input.reportType : schedule.reportType,
            reportSellerId:
                input.reportSellerId !== undefined
                    ? input.reportSellerId ?? null
                    : schedule.reportSellerId,
            recipients:
                input.recipients !== undefined
                    ? input.recipients?.map(String) ?? null
                    : schedule.recipients,
            dateRangeMode:
                input.dateRangeMode !== undefined ? input.dateRangeMode : schedule.dateRangeMode,
            timezone: input.timezone ?? schedule.timezone,
            activeFrom: input.activeFrom !== undefined ? input.activeFrom : schedule.activeFrom,
            activeUntil: input.activeUntil !== undefined ? input.activeUntil : schedule.activeUntil,
            label: input.label !== undefined ? input.label : schedule.label,
        });
        this.assertValidRule(schedule);
        // Re-checked on every update: the target can be changed here, and the
        // channel it must live in is the one already on the rule.
        if (schedule.kind !== 'REPORT') {
            await this.assertTargetExists(schedule.targetType!, schedule.targetId!, schedule.channel);
        }
        const saved = await repository.save(schedule);
        // Editing the pattern invalidates every occurrence not yet executed.
        // Executed rows are history and are deliberately left untouched.
        await this.discardPendingRuns(ctx, saved.id);
        await this.materialise(ctx, saved);
        await this.decorate(ctx, [saved]);
        return saved;
    }

    async delete(ctx: RequestContext, id: ID): Promise<void> {
        await this.assertFound(ctx, id);
        await this.connection.getRepository(ctx, AvailabilitySchedule).delete({ id });
    }

    async setEnabled(ctx: RequestContext, id: ID, isEnabled: boolean): Promise<AvailabilitySchedule> {
        const schedule = await this.assertFound(ctx, id);
        schedule.isEnabled = isEnabled;
        const saved = await this.connection.getRepository(ctx, AvailabilitySchedule).save(schedule);
        if (isEnabled) {
            await this.materialise(ctx, saved);
            await this.decorate(ctx, [saved]);
            return saved;
        }
        // Pausing cancels rather than deletes: a CANCELLED row records that a
        // human intervened, where a missing row would record nothing at all.
        await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .update(
                { schedule: { id: saved.id }, status: 'PENDING' },
                { status: 'CANCELLED', note: 'Parent schedule was paused.' },
            );
        await this.decorate(ctx, [saved]);
        return saved;
    }

    /**
     * Expands enabled rules into PENDING run rows for the next horizon window.
     *
     * Inserts are conflict-ignoring, so the unique (schedule, dueAt, action)
     * index absorbs repeats. That is what makes this safe to call every tick,
     * twice in a row, or after a crash mid-insert. A read-then-write existence
     * check would leave a race in exactly that gap.
     */
    async materialise(ctx: RequestContext, schedule?: AvailabilitySchedule): Promise<number> {
        const schedules = schedule
            ? [schedule]
            : await this.connection
                  .getRepository(ctx, AvailabilitySchedule)
                  .find({ where: { isEnabled: true } });
        const from = new Date();
        const to = new Date(from.getTime() + MATERIALISATION_HORIZON_HOURS * MILLISECONDS_PER_HOUR);
        const rows = schedules.flatMap(rule =>
            computeOccurrences({ rule, from, to }).map(occurrence => ({
                schedule: { id: rule.id },
                dueAt: occurrence.dueAt,
                action: occurrence.action,
                status: 'PENDING' as const,
                attempts: 0,
            })),
        );
        if (!rows.length) {
            return 0;
        }
        const result = await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .createQueryBuilder()
            .insert()
            .into(AvailabilityScheduleRun)
            .values(rows)
            // Emits INSERT IGNORE on MySQL, so the unique (schedule, dueAt, action)
            // index silently absorbs occurrences already materialised by an earlier
            // tick. This is what makes the sweep safe to run every minute.
            .orIgnore()
            // Mandatory alongside `orIgnore` on MySQL. Left on, TypeORM tries to hydrate
            // the DB-side defaults back onto these objects, which needs the ids it
            // did not get: an INSERT IGNORE that skips every row returns insertId 0,
            // so the id stays undefined and TypeORM throws "Cannot update entity
            // because entity id is not set in the entity" -- on every tick after the
            // first, i.e. exactly when the unique index does its job. The insert
            // result is discarded here anyway, so hydration is pure cost.
            .updateEntity(false)
            .execute();
        // Rows actually written, not rows offered. `rows.length` counts the whole
        // horizon, which after the first tick is almost entirely duplicates.
        return Number((result.raw as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
    }

    /**
     * Returns the next occurrences an unsaved rule would produce, without
     * persisting anything. Cron patterns are easy to get wrong and expensive to
     * get wrong on a live storefront; this turns a silent mistake into a
     * visible list before the admin commits.
     */
    previewOccurrences(
        input: CreateAvailabilityScheduleInput,
        count = DEFAULT_PREVIEW_COUNT,
    ): AvailabilityOccurrence[] {
        const rule: OccurrenceRule = {
            kind: input.kind ?? DEFAULT_SCHEDULE_KIND,
            mode: input.mode,
            runAt: input.runAt ?? null,
            action: input.action ?? null,
            disableCron: input.disableCron ?? null,
            enableCron: input.enableCron ?? null,
            sendCron: input.sendCron ?? null,
            timezone: input.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
            activeFrom: input.activeFrom ?? null,
            activeUntil: input.activeUntil ?? null,
            isEnabled: true,
        };
        assertValidTimezone(rule.timezone);
        assertValidCron(rule.disableCron, rule.timezone, 'disableCron');
        assertValidCron(rule.enableCron, rule.timezone, 'enableCron');
        assertValidCron(rule.sendCron ?? null, rule.timezone, 'sendCron');
        const from = new Date();
        // A wide window so a weekly or monthly pattern still yields `count`
        // rows; the slice, not the horizon, is what bounds the result.
        const to = new Date(from.getTime() + PREVIEW_HORIZON_DAYS * 24 * MILLISECONDS_PER_HOUR);
        return computeOccurrences({ rule, from, to }).slice(0, count);
    }

    /** Materialises and immediately drains one rule. Used by the "run now" mutation. */
    async runNow(ctx: RequestContext, id: ID): Promise<void> {
        const schedule = await this.assertFound(ctx, id);
        await this.materialise(ctx, schedule);
        await this.executeDueRuns(ctx);
    }

    async cancelRun(ctx: RequestContext, runId: ID): Promise<boolean> {
        const result = await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .update(
                { id: runId, status: 'PENDING' },
                { status: 'CANCELLED', note: 'Cancelled by an administrator.' },
            );
        return result.affected === 1;
    }

    /**
     * Returns runs stuck in RUNNING to PENDING so a later tick retries them.
     *
     * A worker killed mid-run -- task timeout, OOM, deploy -- leaves the row
     * claimed forever, because every query filters on PENDING. `updatedAt` is
     * the marker: the claim itself wrote it.
     */
    async reclaimStuckRuns(ctx: RequestContext): Promise<number> {
        const cutoff = new Date(Date.now() - STUCK_RUN_RECLAIM_MINUTES * 60_000);
        const result = await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .update(
                { status: 'RUNNING', updatedAt: LessThanOrEqual(cutoff) },
                { status: 'PENDING', note: 'Reclaimed after the previous attempt did not finish.' },
            );
        const reclaimed = result.affected ?? 0;
        if (reclaimed > 0) {
            Logger.warn(`Reclaimed ${reclaimed} stuck availability run(s)`, loggerCtx);
        }
        return reclaimed;
    }

    /**
     * Claims and applies every run that has come due. Each run is isolated: one
     * bad target must not abort the rest of the tick.
     */
    async executeDueRuns(ctx: RequestContext): Promise<void> {
        const now = new Date();
        const dueRuns = await this.connection.getRepository(ctx, AvailabilityScheduleRun).find({
            where: { status: 'PENDING', dueAt: LessThanOrEqual(now) },
            relations: { schedule: { channel: true } },
            order: { dueAt: 'ASC' },
            take: MAX_RUNS_PER_TICK,
        });
        for (const run of dueRuns) {
            await this.executeRun(ctx, run, now);
        }
    }

    private async executeRun(
        ctx: RequestContext,
        run: AvailabilityScheduleRun,
        now: Date,
    ): Promise<void> {
        if (!(await this.claimRun(ctx, run.id))) {
            // Another process took it first -- the "run now" mutation on the
            // server races the sweep tick on the worker, and no scheduler lock
            // spans both processes.
            return;
        }
        try {
            if (decideRunDisposition({ dueAt: run.dueAt, now, graceMinutes: STALE_RUN_GRACE_MINUTES }) === 'SKIP_STALE') {
                await this.finishRun(ctx, run.id, {
                    status: 'SKIPPED',
                    note: `Due at ${run.dueAt.toISOString()}, outside the ${STALE_RUN_GRACE_MINUTES} minute grace window.`,
                });
                return;
            }
            const channelCtx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: run.schedule.channel,
            });
            // Dispatch on kind before reaching the applier registry. The registry
            // is about availability specifically -- its contract is a
            // `shouldBeAvailable` boolean and a NOOP check comparing current
            // state, neither of which means anything for "send a PDF". Routing
            // reports through it would corrupt a clean abstraction to save a
            // branch.
            if (run.schedule.kind === 'REPORT') {
                // Read through channelCtx, not ctx: the scope function resolves
                // the brand from the ACTIVE channel, and ctx here belongs to the
                // sweep rather than to the rule's channel.
                const stored = (await this.settingsStore.get(
                    MARKET_CLOSURE_SETTING_KEY,
                    channelCtx,
                )) as Partial<MarketClosureConfig> | undefined;
                // Spread over the defaults so a calendar saved before a future
                // field existed arrives with real arrays instead of undefined.
                const closureConfig: MarketClosureConfig = {
                    ...DEFAULT_MARKET_CLOSURE_CONFIG,
                    ...(stored ?? {}),
                };
                // Resolved per run, not frozen on the rule: a city added to the
                // brand after this rule was written is covered from its next run
                // without anyone re-editing it.
                const reportChannelIds = await this.resolveSellerChannelIds(
                    ctx,
                    run.schedule.reportSellerId,
                );
                if (!reportChannelIds.length) {
                    await this.finishRun(ctx, run.id, {
                        status: 'SKIPPED',
                        note: `Brand ${String(run.schedule.reportSellerId)} has no reportable channels.`,
                    });
                    return;
                }
                const sendResult = await this.reportSender.sendReport({
                    // `channel` is the Channel entity here, not its token.
                    channelToken: run.schedule.channel.token,
                    reportType: run.schedule.reportType!,
                    dateRangeMode: run.schedule.dateRangeMode!,
                    reportChannelIds,
                    recipients: run.schedule.recipients ?? [],
                    timezone: run.schedule.timezone,
                    closureConfig,
                });
                if ('closed' in sendResult) {
                    await this.finishRun(ctx, run.id, {
                        status: 'CLOSED',
                        note: sendResult.reason,
                    });
                    return;
                }
                await this.finishRun(ctx, run.id, {
                    status: 'DONE',
                    note: `Sent to ${sendResult.recipientCount} recipient(s). ${sendResult.note}`,
                });
                return;
            }
            const result = await this.applierRegistry.applyAvailability({
                ctx: channelCtx,
                targetType: run.schedule.targetType!,
                targetId: run.schedule.targetId!,
                shouldBeAvailable: run.action === 'ENABLE',
            });
            await this.finishRun(ctx, run.id, {
                status: result.outcome === 'NOOP' ? 'NOOP' : 'DONE',
                note: result.note,
            });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Availability run ${String(run.id)} failed: ${message}`, loggerCtx);
            await this.connection.getRepository(ctx, AvailabilityScheduleRun).update(
                { id: run.id },
                {
                    status: 'FAILED',
                    lastError: message,
                    attempts: run.attempts + 1,
                    executedAt: new Date(),
                },
            );
        }
    }

    /**
     * Flips PENDING to RUNNING in one statement and reports whether this caller
     * won. Conditioning on the current status is what makes it atomic: two
     * processes issue the same UPDATE, the database serialises them, and only
     * the first sees a non-zero affected count.
     */
    private async claimRun(ctx: RequestContext, runId: ID): Promise<boolean> {
        const result = await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .update({ id: runId, status: 'PENDING' }, { status: 'RUNNING' });
        return result.affected === 1;
    }

    /**
     * The channels a brand's report covers, resolved at the moment of asking.
     *
     * Not named resolveBrandChannelIds: a function by that name already exists in
     * Authenticated/shared and answers a different question (which channels a
     * customer joins on login). Two functions with one name and two meanings is
     * how the wrong one gets called.
     *
     * The default channel is excluded. It aggregates every other channel's
     * catalogue, so including it beside real channels double-counts every order --
     * the same reason the old channel picker filtered it out of the UI.
     */
    async resolveSellerChannelIds(ctx: RequestContext, sellerId: ID | null): Promise<string[]> {
        if (sellerId == null) {
            return [];
        }
        const channels = await this.connection
            .getRepository(ctx, Channel)
            .find({ where: { seller: { id: sellerId } } });
        return channels
            .filter(channel => channel.code !== DEFAULT_CHANNEL_CODE)
            .map(channel => String(channel.id));
    }

    private async finishRun(
        ctx: RequestContext,
        runId: ID,
        outcome: { status: 'DONE' | 'NOOP' | 'SKIPPED' | 'CLOSED'; note: string | null },
    ): Promise<void> {
        await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .update({ id: runId }, { ...outcome, executedAt: new Date() });
    }

    private async discardPendingRuns(ctx: RequestContext, scheduleId: ID): Promise<void> {
        await this.connection
            .getRepository(ctx, AvailabilityScheduleRun)
            .delete({ schedule: { id: scheduleId }, status: In(['PENDING']) });
    }

    /**
     * Searches candidate targets inside a specific channel.
     *
     * Takes a channel id rather than trusting `ctx`, because the admin picking a
     * target is browsing one channel while authoring a rule for another. Search
     * results that the rule could never act on are worse than no results.
     */
    async searchTargets(
        targetType: AvailabilityTargetType,
        channelId: ID,
        term: string,
    ): Promise<AvailabilityTargetSummary[]> {
        const trimmed = term.trim();
        if (trimmed.length < 2) {
            return [];
        }
        const channelCtx = await this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: await this.connection.rawConnection
                .getRepository(Channel)
                .findOneOrFail({ where: { id: channelId as any } }),
        });
        const options = {
            take: TARGET_SEARCH_LIMIT,
            filter: { name: { contains: trimmed } },
        } as any;
        if (targetType === 'Product') {
            const result = await this.productService.findAll(channelCtx, options, ['featuredAsset']);
            return result.items.map(product => ({
                id: product.id,
                name: product.name,
                asset: product.featuredAsset ?? null,
            }));
        }
        const result = await this.collectionService.findAll(channelCtx, options, ['featuredAsset']);
        return result.items.map(collection => ({
            id: collection.id,
            name: collection.name,
            asset: collection.featuredAsset ?? null,
        }));
    }

    /**
     * Refuses a rule whose target does not exist in the rule's own channel.
     *
     * Without this the rule saves happily and then fails on every occurrence
     * with "entity with id not found", hours later, in a worker log. Catching it
     * at save time turns a silent recurring failure into a sentence the admin
     * can act on while the form is still open.
     */
    private async assertTargetExists(
        targetType: AvailabilityTargetType,
        targetId: ID,
        channel: Channel,
    ): Promise<void> {
        const channelCtx = await this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: channel,
        });
        const found =
            targetType === 'Product'
                ? await this.productService.findOne(channelCtx, targetId)
                : await this.collectionService.findOne(channelCtx, targetId);
        if (!found) {
            throw new UserInputError(
                `${targetType} ${String(targetId)} does not exist in channel "${channel.code}". ` +
                    'Assign it to that channel first, or create the schedule on a channel that has it.',
            );
        }
    }

    /** Attaches everything the admin UI needs but the table does not store. */
    private async decorate(ctx: RequestContext, schedules: AvailabilitySchedule[]): Promise<void> {
        await Promise.all([
            this.attachRunSummaries(ctx, schedules),
            this.attachTargetSummaries(schedules),
        ]);
    }

    /**
     * Resolves each target's display name and thumbnail.
     *
     * Grouped by channel, not done in the caller's context, because
     * `ProductService.findByIds` filters by the channel on the RequestContext:
     * an admin viewing from Madurai would otherwise see "not found" for every
     * rule belonging to Kochi. One context and at most two queries per distinct
     * channel on the page, which in practice is one or two.
     *
     * Failures are swallowed per channel. A name is decoration; losing it must
     * not take down the list that shows whether schedules are firing.
     */
    private async attachTargetSummaries(schedules: AvailabilitySchedule[]): Promise<void> {
        const byChannelId = new Map<string, AvailabilitySchedule[]>();
        for (const schedule of schedules) {
            const key = String(schedule.channel?.id ?? '');
            if (!key) {
                continue;
            }
            byChannelId.set(key, [...(byChannelId.get(key) ?? []), schedule]);
        }
        await Promise.all(
            [...byChannelId.values()].map(group => this.attachTargetsForChannel(group)),
        );
    }

    /**
     * Brand name and member channels for every seller named by these rules.
     *
     * Returns a map rather than decorating in place so the caller keeps its one
     * loop over schedules, and so an unresolvable seller (deleted brand) simply
     * misses from the map instead of throwing mid-list.
     */
    private async loadBrandsFor(
        ctx: RequestContext,
        schedules: AvailabilitySchedule[],
    ): Promise<Map<string, { name: string; channels: Channel[] }>> {
        const sellerIds = [
            ...new Set(
                schedules
                    .filter(schedule => schedule.kind === 'REPORT' && schedule.reportSellerId != null)
                    .map(schedule => String(schedule.reportSellerId)),
            ),
        ];
        const brands = new Map<string, { name: string; channels: Channel[] }>();
        if (!sellerIds.length) {
            return brands;
        }
        const channels = await this.connection
            .getRepository(ctx, Channel)
            .find({ where: { seller: { id: In(sellerIds) } }, relations: ['seller'] });
        for (const channel of channels) {
            const sellerId = String(channel.seller?.id ?? '');
            if (!sellerId) {
                continue;
            }
            const brand = brands.get(sellerId) ?? { name: channel.seller?.name ?? '', channels: [] };
            // The default channel aggregates every other channel's catalogue, so
            // it is excluded here for the same reason it is excluded at run time.
            if (channel.code !== DEFAULT_CHANNEL_CODE) {
                brand.channels.push(channel);
            }
            brands.set(sellerId, brand);
        }
        return brands;
    }

    private async attachTargetsForChannel(schedules: AvailabilitySchedule[]): Promise<void> {
        try {
            const channelCtx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: schedules[0].channel,
            });
            // REPORT rows have no target and are filtered out here by having a
            // null targetType, so they cost nothing in these lookups.
            const productIds = schedules
                .filter(schedule => schedule.targetType === 'Product' && schedule.targetId != null)
                .map(schedule => schedule.targetId as ID);
            const collectionIds = schedules
                .filter(schedule => schedule.targetType === 'Collection' && schedule.targetId != null)
                .map(schedule => schedule.targetId as ID);
            const [products, collections] = await Promise.all([
                productIds.length
                    ? this.productService.findByIds(channelCtx, productIds, ['featuredAsset'])
                    : Promise.resolve([]),
                collectionIds.length
                    ? this.collectionService.findByIds(channelCtx, collectionIds, ['featuredAsset'])
                    : Promise.resolve([]),
            ]);
            const targets = new Map<string, { name: string; asset: Asset | null }>();
            for (const product of products) {
                targets.set(`Product:${String(product.id)}`, {
                    name: product.name,
                    asset: product.featuredAsset ?? null,
                });
            }
            for (const collection of collections) {
                targets.set(`Collection:${String(collection.id)}`, {
                    name: collection.name,
                    asset: collection.featuredAsset ?? null,
                });
            }
            // One lookup for the whole group rather than one per row: a channel's
            // report rules almost always name the same brand, and the list would
            // otherwise issue a query per row to print the same word.
            const brands = await this.loadBrandsFor(channelCtx, schedules);
            for (const schedule of schedules) {
                if (schedule.kind === 'REPORT') {
                    // The list's primary column is targetName. A report has no
                    // entity to name, so it borrows its own label — otherwise
                    // every report row renders as "Product #undefined (deleted)".
                    schedule.targetName = schedule.label ?? 'Purchase list report';
                    schedule.targetAsset = null;
                    const brand = brands.get(String(schedule.reportSellerId));
                    schedule.reportSellerName = brand?.name ?? null;
                    schedule.reportChannels = brand?.channels ?? [];
                    continue;
                }
                const target = targets.get(`${schedule.targetType}:${String(schedule.targetId)}`);
                schedule.targetName = target?.name ?? null;
                schedule.targetAsset = target?.asset ?? null;
            }
        } catch (err: unknown) {
            Logger.warn(
                `Could not resolve availability targets: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                loggerCtx,
            );
        }
    }

    /**
     * Fills in `latestRun` and `nextRun` for a page of schedules using two
     * queries, not two per row.
     *
     * A GraphQL `@ResolveField` would have been the idiomatic place for this, but
     * it fires once per row: a 200-row list would issue 400 queries. Batching here
     * keeps the cost flat, and the field stays derived rather than stored, so a run
     * executed by the worker is reflected on the next read with nothing to keep in
     * sync.
     */
    private async attachRunSummaries(
        ctx: RequestContext,
        schedules: AvailabilitySchedule[],
    ): Promise<void> {
        if (!schedules.length) {
            return;
        }
        const scheduleIds = schedules.map(schedule => schedule.id);
        const repository = this.connection.getRepository(ctx, AvailabilityScheduleRun);
        // Grouped subqueries rather than "fetch everything and take the first":
        // a rule running nightly accumulates hundreds of executed rows, and this
        // list is read on every page load.
        const [latestRuns, nextRuns] = await Promise.all([
            // Executed rows only. A PENDING row is not an outcome, and showing one
            // as "last run" would claim the rule fired when it has not.
            repository
                .createQueryBuilder('run')
                // Joined purely to carry the owning id back, so the rows can be
                // keyed without a second lookup.
                .leftJoinAndSelect('run.schedule', 'schedule')
                .where('run.scheduleId IN (:...scheduleIds)', { scheduleIds })
                .andWhere(
                    `(run.scheduleId, run.executedAt) IN (
                        SELECT latest.scheduleId, MAX(latest.executedAt)
                        FROM availability_schedule_run latest
                        WHERE latest.scheduleId IN (:...scheduleIds)
                          AND latest.executedAt IS NOT NULL
                        GROUP BY latest.scheduleId
                    )`,
                    { scheduleIds },
                )
                // Only breaks ties, so two runs finishing in the same millisecond
                // resolve the same way on every request.
                .orderBy('run.executedAt', 'DESC')
                .addOrderBy('run.id', 'DESC')
                .getMany(),
            repository
                .createQueryBuilder('run')
                // Joined purely to carry the owning id back, so the rows can be
                // keyed without a second lookup.
                .leftJoinAndSelect('run.schedule', 'schedule')
                .where('run.scheduleId IN (:...scheduleIds)', { scheduleIds })
                .andWhere(
                    `(run.scheduleId, run.dueAt) IN (
                        SELECT upcoming.scheduleId, MIN(upcoming.dueAt)
                        FROM availability_schedule_run upcoming
                        WHERE upcoming.scheduleId IN (:...scheduleIds)
                          AND upcoming.status = 'PENDING'
                          AND upcoming.dueAt >= :now
                        GROUP BY upcoming.scheduleId
                    )`,
                    { scheduleIds, now: new Date() },
                )
                .andWhere('run.status = :pending', { pending: 'PENDING' })
                .orderBy('run.dueAt', 'ASC')
                .addOrderBy('run.id', 'ASC')
                .getMany(),
        ]);
        const latestByScheduleId = firstPerSchedule(latestRuns);
        const nextByScheduleId = firstPerSchedule(nextRuns);
        for (const schedule of schedules) {
            const key = String(schedule.id);
            schedule.latestRun = latestByScheduleId.get(key) ?? null;
            schedule.nextRun = nextByScheduleId.get(key) ?? null;
        }
    }

    private async assertFound(ctx: RequestContext, id: ID): Promise<AvailabilitySchedule> {
        const schedule = await this.findOne(ctx, id);
        if (!schedule) {
            throw new EntityNotFoundError('AvailabilitySchedule' as any, id);
        }
        return schedule;
    }

    private async findAdministratorForUser(
        ctx: RequestContext,
        userId: ID,
    ): Promise<Administrator | null> {
        const administrator = await this.connection
            .getRepository(ctx, Administrator)
            .findOne({ where: { user: { id: userId } } });
        return administrator ?? null;
    }

    /**
     * One validator for both create and update, so the two can never drift.
     * Rejects the combinations that would otherwise produce a rule the
     * materialiser silently expands into nothing.
     */
    private assertValidRule(schedule: AvailabilitySchedule): void {
        assertValidTimezone(schedule.timezone);
        if (schedule.activeFrom && schedule.activeUntil && schedule.activeUntil <= schedule.activeFrom) {
            throw new UserInputError('activeUntil must be later than activeFrom');
        }
        if (schedule.kind === 'REPORT') {
            this.assertValidReportRule(schedule);
            return;
        }
        // An AVAILABILITY row must not carry report columns. Rejecting rather
        // than ignoring them matters: an ignored `recipients` list reads, months
        // later, as "this rule notifies someone" when it never has and never
        // will.
        if (
            schedule.sendCron ||
            schedule.reportType ||
            schedule.recipients?.length ||
            schedule.reportSellerId != null ||
            schedule.dateRangeMode
        ) {
            throw new UserInputError('An availability schedule must not define report fields');
        }
        if (!schedule.targetType || schedule.targetId == null) {
            throw new UserInputError('An availability schedule requires targetType and targetId');
        }
        if (schedule.mode === 'ONE_OFF') {
            if (!schedule.runAt || !schedule.action) {
                throw new UserInputError('A ONE_OFF schedule requires both runAt and action');
            }
            if (schedule.disableCron || schedule.enableCron) {
                throw new UserInputError('A ONE_OFF schedule must not define cron patterns');
            }
            return;
        }
        if (!schedule.disableCron && !schedule.enableCron) {
            throw new UserInputError('A RECURRING schedule requires disableCron or enableCron');
        }
        if (schedule.runAt || schedule.action) {
            throw new UserInputError('A RECURRING schedule must not define runAt or action');
        }
        assertValidCron(schedule.disableCron, schedule.timezone, 'disableCron');
        assertValidCron(schedule.enableCron, schedule.timezone, 'enableCron');
    }

    /**
     * Mirror image of the availability checks: everything the other half needs
     * is forbidden here, and vice versa. Kept as its own method so the two sets
     * of rules never grow into one nested conditional nobody can read.
     */
    private assertValidReportRule(schedule: AvailabilitySchedule): void {
        if (schedule.mode !== 'RECURRING') {
            throw new UserInputError('A report schedule must be RECURRING');
        }
        if (schedule.targetType || schedule.targetId != null) {
            throw new UserInputError('A report schedule must not define a product or collection target');
        }
        if (schedule.disableCron || schedule.enableCron || schedule.runAt || schedule.action) {
            throw new UserInputError('A report schedule must not define availability fields');
        }
        if (!schedule.reportType) {
            throw new UserInputError('A report schedule requires reportType');
        }
        if (!schedule.dateRangeMode) {
            throw new UserInputError('A report schedule requires dateRangeMode');
        }
        if (!schedule.recipients?.length) {
            throw new UserInputError('A report schedule requires at least one recipient');
        }
        if (schedule.reportSellerId == null) {
            throw new UserInputError('A report schedule requires a brand to report on');
        }
        if (!schedule.sendCron) {
            throw new UserInputError('A report schedule requires sendCron');
        }
        assertValidCron(schedule.sendCron, schedule.timezone, 'sendCron');
    }
}

/**
 * Keys runs by their owning schedule id, keeping the first of each. The caller
 * has already ordered the rows, so "first" means "the one that matters".
 */
function firstPerSchedule(runs: AvailabilityScheduleRun[]): Map<string, AvailabilityScheduleRun> {
    const byScheduleId = new Map<string, AvailabilityScheduleRun>();
    for (const run of runs) {
        const key = String(run.schedule?.id ?? '');
        if (key && !byScheduleId.has(key)) {
            byScheduleId.set(key, run);
        }
    }
    return byScheduleId;
}

function assertValidTimezone(timezone: string): void {
    try {
        // Throws RangeError on an unknown IANA zone.
        new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
        throw new UserInputError(`Unknown timezone: ${timezone}`);
    }
}

function assertValidCron(pattern: string | null, timezone: string, field: string): void {
    if (!pattern) {
        return;
    }
    try {
        new Cron(pattern, { timezone });
    } catch {
        throw new UserInputError(`Invalid cron pattern for ${field}: ${pattern}`);
    }
}
