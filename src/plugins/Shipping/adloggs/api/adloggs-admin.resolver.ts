import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Permission, RequestContext, Transaction } from '@vendure/core';

import { AdloggsFulfillmentService, SyncResult } from '../fulfillment/adloggs-fulfillment.service';
import { AdloggsService } from '../services/adloggs.service';

@Resolver()
export class AdloggsAdminResolver {
    constructor(
        private adloggs: AdloggsService,
        private adloggsFulfillmentService: AdloggsFulfillmentService,
    ) {}

    @Query()
    @Allow(Permission.ReadOrder)
    async adloggsWalletBalance(): Promise<{ enabled: boolean; balance?: string; message?: string }> {
        const result = await this.adloggs.getWalletBalance();
        if (!result.status) {
            return { enabled: false, message: result.message };
        }
        if (result.data?.code === 'wallet_not_enabled') {
            return { enabled: false, message: 'Wallet not enabled for this Adloggs account' };
        }
        return { enabled: true, balance: result.data?.wallet_balance };
    }

    @Mutation()
    @Transaction()
    @Allow(Permission.UpdateOrder)
    async syncAdloggsStatus(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ): Promise<SyncResult> {
        return this.adloggsFulfillmentService.syncFulfillment(ctx, args.fulfillmentId);
    }
}
