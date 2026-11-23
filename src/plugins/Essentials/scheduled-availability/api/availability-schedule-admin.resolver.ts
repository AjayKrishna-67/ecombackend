import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ID,
    ListQueryOptions,
    PaginatedList,
    Permission,
    RequestContext,
    Transaction,
} from '@vendure/core';
import { AvailabilityTargetType } from '../constants';
import { AvailabilityScheduleRun } from '../entities/availability-schedule-run.entity';
import { AvailabilitySchedule } from '../entities/availability-schedule.entity';
import { AvailabilityOccurrence } from '../functions/compute-occurrences';
import {
    AvailabilityScheduleService,
    AvailabilityTargetSummary,
} from '../services/availability-schedule.service';
import { CreateAvailabilityScheduleInput, UpdateAvailabilityScheduleInput } from '../types';

/**
 * Every method allows Permission.SuperAdmin and nothing else.
 *
 * `@Allow` is an OR: adding any second permission here would open scheduling to
 * every role holding it. Since a schedule can take an entire storefront offline
 * at a chosen hour, the capability is deliberately non-delegable -- which is
 * also why the plugin defines no CrudPermissionDefinition of its own.
 */
@Resolver()
export class AvailabilityScheduleAdminResolver {
    constructor(private availabilityScheduleService: AvailabilityScheduleService) {}

    @Query()
    @Allow(Permission.SuperAdmin)
    availabilitySchedules(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: ListQueryOptions<AvailabilitySchedule>; allChannels?: boolean },
    ): Promise<PaginatedList<AvailabilitySchedule>> {
        return this.availabilityScheduleService.findAll(ctx, args.options, args.allChannels === true);
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    async availabilitySchedule(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<AvailabilitySchedule | null> {
        return (await this.availabilityScheduleService.findOne(ctx, args.id)) ?? null;
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    availabilityScheduleRuns(
        @Ctx() ctx: RequestContext,
        @Args() args: { scheduleId: ID; options?: ListQueryOptions<AvailabilityScheduleRun> },
    ): Promise<PaginatedList<AvailabilityScheduleRun>> {
        return this.availabilityScheduleService.findRuns(ctx, args.scheduleId, args.options);
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    availabilityTargetSearch(
        @Ctx() ctx: RequestContext,
        @Args() args: { targetType: AvailabilityTargetType; channelId: ID; term: string },
    ): Promise<AvailabilityTargetSummary[]> {
        return this.availabilityScheduleService.searchTargets(
            args.targetType,
            args.channelId,
            args.term,
        );
    }

    @Query()
    @Allow(Permission.SuperAdmin)
    previewAvailabilitySchedule(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: CreateAvailabilityScheduleInput; count?: number },
    ): AvailabilityOccurrence[] {
        return this.availabilityScheduleService.previewOccurrences(args.input, args.count);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.SuperAdmin)
    createAvailabilitySchedule(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: CreateAvailabilityScheduleInput },
    ): Promise<AvailabilitySchedule> {
        return this.availabilityScheduleService.create(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.SuperAdmin)
    updateAvailabilitySchedule(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: UpdateAvailabilityScheduleInput },
    ): Promise<AvailabilitySchedule> {
        return this.availabilityScheduleService.update(ctx, args.input);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.SuperAdmin)
    async deleteAvailabilitySchedule(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<boolean> {
        await this.availabilityScheduleService.delete(ctx, args.id);
        return true;
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.SuperAdmin)
    setAvailabilityScheduleEnabled(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID; isEnabled: boolean },
    ): Promise<AvailabilitySchedule> {
        return this.availabilityScheduleService.setEnabled(ctx, args.id, args.isEnabled);
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.SuperAdmin)
    cancelAvailabilityScheduleRun(
        @Ctx() ctx: RequestContext,
        @Args() args: { runId: ID },
    ): Promise<boolean> {
        return this.availabilityScheduleService.cancelRun(ctx, args.runId);
    }

    @Mutation()
    @Allow(Permission.SuperAdmin)
    async runAvailabilityScheduleNow(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ): Promise<boolean> {
        await this.availabilityScheduleService.runNow(ctx, args.id);
        return true;
    }
}
