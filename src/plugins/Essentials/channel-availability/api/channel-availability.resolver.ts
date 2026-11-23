import { Query, Resolver, Args } from '@nestjs/graphql';
import { Ctx, RequestContext, UserInputError } from '@vendure/core';
import { ChannelAvailabilityService } from '../services/channel-availability.service';
import { BrandStorefrontService } from '../services/brand-storefront.service';

@Resolver()
export class ChannelAvailabilityResolver {
    constructor(
        private channelAvailabilityService: ChannelAvailabilityService,
        private brandStorefrontService: BrandStorefrontService,
    ) {}

    @Query()
    async getAvailableChannels(
        @Ctx() ctx: RequestContext,
        @Args() args: { postalCode?: string; type?: string }
    ) {
        return this.channelAvailabilityService.getAvailableChannelsForActiveOrder(
            ctx,
            args.postalCode,
            args.type as any,
        );
    }

    @Query()
    async brandChannels(
        @Ctx() ctx: RequestContext,
        @Args() args: { sellerId?: string; sellerName?: string; postalCode?: string; country?: string },
    ) {
        // Omit both → use the brand that owns the current token's channel.
        // Pass sellerId → look at a different brand (Switch Store). sellerName is
        // the id-free alternative; sellerId wins when both are given, so a client
        // that sends a stale name alongside a known id still gets the right brand.
        let sellerId = args.sellerId ?? null;
        if (!sellerId && args.sellerName) {
            sellerId = await this.channelAvailabilityService.resolveSellerIdByName(ctx, args.sellerName);
            // Distinct from the fallback error below: the caller named a brand we
            // don't have, which is a different fix than "send a sellerId".
            if (!sellerId) {
                throw new UserInputError(`No brand named "${args.sellerName}".`);
            }
        }
        sellerId = sellerId ?? (await this.channelAvailabilityService.resolveActiveSellerId(ctx));
        if (!sellerId) {
            throw new UserInputError(
                'Could not determine the brand from the current channel; pass sellerId or sellerName.',
            );
        }
        const rows = await this.channelAvailabilityService.getAvailableChannelsForActiveOrder(
            ctx,
            args.postalCode,
            undefined,
            sellerId,
            args.country,
        );
        return rows.map(row => ({
            id: row.id,
            code: row.code,
            name: row.name,
            token: row.token,
            type: row.type,
        }));
    }

    @Query()
    async switcherBrands(
        @Ctx() ctx: RequestContext,
        @Args() args: { postalCode?: string },
    ) {
        return this.channelAvailabilityService.getSwitcherBrandsForActiveOrder(ctx, args.postalCode);
    }

    @Query()
    async brandStorefronts(
        @Ctx() ctx: RequestContext,
        @Args() args: { postalCode?: string; country?: string },
    ) {
        const rows = await this.brandStorefrontService.findPublished(ctx);
        const sellerIds = rows.map(r => String(r.seller?.id));
        // With a pincode, flag each brand by whether any of its channels delivers
        // there (app greys the ones that can't) and attach its deliverable channels
        // + tokens. Without a pincode, all available and channels empty.
        const availMap = args.postalCode
            ? await this.channelAvailabilityService.resolveSellerAvailability(
                  ctx,
                  sellerIds,
                  args.postalCode,
              )
            : null;
        const channelMap = args.postalCode
            ? await this.channelAvailabilityService.resolveChannelsBySellers(
                  ctx,
                  sellerIds,
                  args.postalCode,
                  args.country,
              )
            : null;
        // Which brands are worldwide → client shows the India/International toggle.
        const intlSet = await this.channelAvailabilityService.resolveSellersWithInternational(
            ctx,
            sellerIds,
        );
        return rows.map(row => {
            const sellerId = String(row.seller?.id);
            return {
                id: row.id,
                seller: { id: row.seller?.id, name: row.seller?.name },
                bannerImage: row.bannerImage,
                launchStatus: row.launchStatus,
                sortOrder: row.sortOrder,
                isAvailable: availMap ? (availMap.get(sellerId) ?? false) : true,
                hasInternational: intlSet.has(sellerId),
                channels: channelMap ? (channelMap.get(sellerId) ?? []) : [],
            };
        });
    }
}
