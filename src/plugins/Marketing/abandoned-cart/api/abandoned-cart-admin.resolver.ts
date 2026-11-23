import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Permission, RequestContext } from '@vendure/core';
import { readAbandonedCartPermission, updateAbandonedCartPermission } from '../permissions';
import { AbandonedCartService } from '../services/abandoned-cart.service';
import { AbandonedCartAnalytics, AbandonedCartConfig } from '../types';

@Resolver()
export class AbandonedCartAdminResolver {
    constructor(private service: AbandonedCartService) {}

    @Query()
    @Allow(readAbandonedCartPermission.Permission, Permission.SuperAdmin)
    async abandonedCartSettings(@Ctx() ctx: RequestContext): Promise<AbandonedCartConfig> {
        return this.service.readConfig(ctx);
    }

    @Query()
    @Allow(readAbandonedCartPermission.Permission, Permission.SuperAdmin)
    async abandonedCartEligiblePreview(@Ctx() ctx: RequestContext): Promise<number> {
        return this.service.countEligible(ctx);
    }

    @Query()
    @Allow(readAbandonedCartPermission.Permission, Permission.SuperAdmin)
    async abandonedCartAnalytics(@Ctx() ctx: RequestContext): Promise<AbandonedCartAnalytics> {
        return this.service.readAnalytics(ctx);
    }

    @Mutation()
    @Allow(updateAbandonedCartPermission.Permission, Permission.SuperAdmin)
    async setAbandonedCartSettings(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: AbandonedCartConfig },
    ): Promise<AbandonedCartConfig> {
        return this.service.writeConfig(ctx, args.input);
    }

    @Mutation()
    @Allow(updateAbandonedCartPermission.Permission, Permission.SuperAdmin)
    async triggerAbandonedCartNudge(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderId: ID; stage: number },
    ): Promise<boolean> {
        return this.service.sendTestNudge(ctx, args.orderId, args.stage);
    }

    @Mutation()
    @Allow(updateAbandonedCartPermission.Permission, Permission.SuperAdmin)
    async sendAbandonedCartTestToPhone(
        @Ctx() ctx: RequestContext,
        @Args() args: { phone: string; stage: number },
    ): Promise<boolean> {
        return this.service.sendTestToPhone(ctx, args.phone, args.stage);
    }
}
