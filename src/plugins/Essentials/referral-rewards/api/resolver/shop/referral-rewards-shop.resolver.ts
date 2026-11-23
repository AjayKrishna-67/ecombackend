import { Args, Query, Mutation, Resolver, ResolveField, Parent } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, CustomerService, TransactionalConnection } from '@vendure/core';
import { LessThanOrEqual } from 'typeorm';
import { ReferralRewardsService } from '../../../service/referral-rewards.service';
import { Referral } from '../../../entities/referral.entity';

@Resolver('Referral')
export class ReferralFieldResolver {
    constructor(private connection: TransactionalConnection) {}

    @ResolveField()
    async referralNumber(@Ctx() ctx: RequestContext, @Parent() referral: Referral): Promise<number> {
        const count = await this.connection.getRepository(ctx, Referral).count({
            where: {
                referrerId: referral.referrerId,
                id: LessThanOrEqual(referral.id),
            },
        });
        return count;
    }
}

@Resolver()
export class ReferralRewardsShopResolver {
    constructor(
        private readonly referralRewardsService: ReferralRewardsService,
        private readonly customerService: CustomerService,
    ) {}

    @Query()
    @Allow(Permission.Authenticated)
    async myReferrals(
        @Ctx() ctx: RequestContext,
        @Args() args: { take?: number; skip?: number; status?: string },
    ) {
        return this.referralRewardsService.getMyReferrals(ctx, args.take, args.skip, args.status);
    }

    @Query()
    @Allow(Permission.Authenticated)
    async earnedScratchCards(
        @Ctx() ctx: RequestContext,
        @Args() args: { take?: number; skip?: number },
    ) {
        return this.referralRewardsService.getEarnedScratchCards(ctx, args.take, args.skip);
    }

    @Query()
    @Allow(Permission.Authenticated)
    async scratchedCards(
        @Ctx() ctx: RequestContext,
        @Args() args: { take?: number; skip?: number },
    ) {
        return this.referralRewardsService.getScratchedCards(ctx, args.take, args.skip);
    }

    @Query()
    @Allow(Permission.Public)
    async referralChannelPoints(@Ctx() ctx: RequestContext) {
        return this.referralRewardsService.getReferralChannelPoints(ctx);
    }

    @Mutation()
    @Allow(Permission.Authenticated)
    async registerReferral(
        @Ctx() ctx: RequestContext,
        @Args() args: { referrerId: string },
    ) {
        const activeUserId = ctx.activeUserId;
        if (!activeUserId) {
            throw new Error('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, activeUserId);
        if (!customer) {
            throw new Error('No customer found for active user');
        }
        return this.referralRewardsService.registerReferral(
            ctx,
            args.referrerId,
            customer.id,
        );
    }

    @Mutation()
    @Allow(Permission.Authenticated)
    async scratchReferralCard(
        @Ctx() ctx: RequestContext,
        @Args() args: { referralNumber: number },
    ) {
        return this.referralRewardsService.scratchReferralCardByNumber(ctx, args.referralNumber);
    }
}
