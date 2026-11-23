import { Query, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, Transaction } from '@vendure/core';
import { CustomOfferService } from '../services/custom-offer.service';
import { CustomOffer } from '../entities/custom-offer.entity';

@Resolver()
export class CustomOfferShopResolver {
    constructor(private customOfferService: CustomOfferService) {}

    @Query()
    async allBannerPopup(@Ctx() ctx: RequestContext): Promise<CustomOffer[]> {
        return this.customOfferService.findByChannel(ctx, String(ctx.channelId));
    }

    @Query()
    @Transaction()
    async nextBannerPopup(@Ctx() ctx: RequestContext): Promise<CustomOffer | null> {
        return this.customOfferService.getNextOfferForRotation(ctx);
    }
}
