import { Args, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    ID,
    ListQueryOptions,
    PaginatedList,
    Permission,
    RequestContext,
} from '@vendure/core';
import { AdminActivityLog } from '../entities/admin-activity-log.entity';
import { adminActivityLogPermission } from '../permissions';
import { AdminActivityLogService, AdminSessionSummary } from '../services/admin-activity-log.service';

/**
 * Read-only resolver for the admin activity log.
 *
 * Every operation lists `Permission.SuperAdmin` alongside the custom permission.
 * Without that fallback the feature fails closed on first deploy, because no
 * existing Role carries a permission that did not exist when the Roles were
 * created — including the SuperAdmin who needs to grant it. Same reason
 * `postal-code-admin.resolver.ts:25` does it.
 */
@Resolver()
export class AdminActivityLogResolver {
    constructor(private readonly adminActivityLogService: AdminActivityLogService) {}

    @Query()
    @Allow(adminActivityLogPermission.Permission, Permission.SuperAdmin)
    async adminActivityLogs(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: ListQueryOptions<AdminActivityLog> },
    ): Promise<PaginatedList<AdminActivityLog>> {
        return this.adminActivityLogService.findAll(ctx, args.options ?? undefined);
    }

    @Query()
    @Allow(adminActivityLogPermission.Permission, Permission.SuperAdmin)
    async adminActivityForEntity(
        @Ctx() ctx: RequestContext,
        @Args() args: { entityType: string; entityId: string; take?: number },
    ): Promise<AdminActivityLog[]> {
        return this.adminActivityLogService.findForEntity(
            ctx,
            args.entityType,
            args.entityId,
            args.take ?? undefined,
        );
    }

    @Query()
    @Allow(adminActivityLogPermission.Permission, Permission.SuperAdmin)
    async adminActivitySessions(
        @Ctx() ctx: RequestContext,
        @Args() args: { skip?: number; take?: number; adminId?: ID; since?: Date },
    ): Promise<PaginatedList<AdminSessionSummary>> {
        return this.adminActivityLogService.findSessions(ctx, {
            skip: args.skip ?? undefined,
            take: args.take ?? undefined,
            adminId: args.adminId ?? undefined,
            since: args.since ?? undefined,
        });
    }

    @Query()
    @Allow(adminActivityLogPermission.Permission, Permission.SuperAdmin)
    async adminActivitySessionTimeline(
        @Ctx() ctx: RequestContext,
        @Args() args: { sessionId: string },
    ): Promise<AdminActivityLog[]> {
        return this.adminActivityLogService.findSessionTimeline(ctx, args.sessionId);
    }
}
