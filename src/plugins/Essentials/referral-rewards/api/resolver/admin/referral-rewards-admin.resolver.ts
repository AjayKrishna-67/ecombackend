import { Args, Query, Mutation, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { ReferralRewardsService } from '../../../service/referral-rewards.service';
import { referralRewardsPermission } from '../../../permissions';

@Resolver()
export class ReferralRewardsAdminResolver {
    constructor(private readonly referralRewardsService: ReferralRewardsService) {}

    @Query()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async referralChannelPoints(@Ctx() ctx: RequestContext) {
        return this.referralRewardsService.getReferralChannelPoints(ctx);
    }

    @Query()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async referralSummary(@Ctx() ctx: RequestContext) {
        return this.referralRewardsService.getReferralSummary(ctx);
    }

    @Query()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async referrals(
        @Ctx() ctx: RequestContext,
        @Args() args: { take?: number; skip?: number },
    ) {
        return this.referralRewardsService.getAllReferrals(ctx, args.take, args.skip);
    }

    @Query()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async referralsForCustomer(
        @Ctx() ctx: RequestContext,
        @Args() args: { customerId: string; take?: number; skip?: number },
    ) {
        return this.referralRewardsService.getReferralsForCustomer(
            ctx,
            args.customerId,
            args.take,
            args.skip,
        );
    }

    @Query()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async referredByForCustomer(
        @Ctx() ctx: RequestContext,
        @Args() args: { customerId: string },
    ) {
        return this.referralRewardsService.getReferredByForCustomer(ctx, args.customerId);
    }

    @Mutation()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async createReferralChannelPoints(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { points: number } },
    ) {
        return this.referralRewardsService.createReferralChannelPoints(ctx, args.input.points);
    }

    @Mutation()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async updateReferralChannelPoints(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string; input: { points: number } },
    ) {
        return this.referralRewardsService.updateReferralChannelPoints(
            ctx,
            args.id,
            args.input.points,
        );
    }

    @Mutation()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async deleteReferralChannelPoints(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: string },
    ) {
        return this.referralRewardsService.deleteReferralChannelPoints(ctx, args.id);
    }

    @Mutation()
    @Allow(referralRewardsPermission.Permission, Permission.SuperAdmin)
    async checkReferralEligibility(
        @Ctx() ctx: RequestContext,
        @Args() args: { referralId: string },
    ) {
        return this.referralRewardsService.checkAndUpdateEligibility(ctx, args.referralId);
    }
}
