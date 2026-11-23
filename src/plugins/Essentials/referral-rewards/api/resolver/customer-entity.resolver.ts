import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Customer, RequestContext } from '@vendure/core';
import { ReferralRewardsService } from '../../service/referral-rewards.service';

@Resolver('Customer')
export class ReferralCustomerEntityResolver {
    constructor(private referralRewardsService: ReferralRewardsService) {}

    @ResolveField()
    async referredBy(
        @Parent() customer: Customer,
        @Ctx() ctx: RequestContext,
    ) {
        return this.referralRewardsService.getReferredByForCustomer(ctx, customer.id);
    }
}
