import { Injectable } from '@nestjs/common';
import {
    Asset,
    CacheService,
    RequestContext,
    ChannelService,
    TransactionalConnection,
    Channel,
    CustomerService,
    Logger,
    Seller,
    UserInputError,
} from '@vendure/core';
import { In, IsNull } from 'typeorm';
import { PostalCode } from '../../postal-code/entities/postal-code.entity';
import { BrandStorefront, BrandLaunchStatus } from '../entities/brand-storefront.entity';
import { BrandStorefrontService } from './brand-storefront.service';
import { BrandSwitcherService } from './brand-switcher.service';
import { decideAvailability, isInternationalType, typeMatchesRegion } from '../functions/availability';

export type ChannelTypeValue = 'CITY' | 'BRAND' | 'DIRECT';

export interface ChannelAvailability {
    id: string;
    code: string;
    token: string;
    name: string;
    isAvailable: boolean;
    message?: string;
    type: ChannelTypeValue;
    launchStatus: BrandLaunchStatus;
    bannerImage: Asset | null;
}

/**
 * Lean channel shape for the drill / nested-switcher path: identify the channel
 * and carry its entry token. Mirrors the BrandChannel GraphQL type.
 */
export interface BrandChannel {
    id: string;
    code: string;
    name: string;
    token: string | null;
    type: string;
}

/**
 * A brand card in one app's "Switch Store" sheet: the brand's storefront
 * content plus its channels, each already availability-resolved. Which brands
 * appear (and their order) comes from the per-app allowlist (BrandSwitcherEntry).
 */
export interface SwitcherBrand {
    seller: { id: string; name: string };
    bannerImage: Asset | null;
    launchStatus: BrandLaunchStatus;
    channels: ChannelAvailability[];
}

interface PostalData {
    codes: string[];
    hasAnywhere: boolean;
}

const CHANNEL_AVAIL_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const CHANNEL_AVAIL_TAG_ALL = 'channel-availability:all';
const POSTAL_TAG_ALL = 'postal-codes:all';
const channelAvailKey = (
    postalCode: string,
    filter?: ChannelTypeValue,
    sellerId?: string,
    country?: string,
) => `channel-availability:${postalCode}:${filter ?? 'all'}:${sellerId ?? 'all'}:${country ?? 'all'}`;


@Injectable()
export class ChannelAvailabilityService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: ChannelService,
        private customerService: CustomerService,
        private cacheService: CacheService,
        private brandStorefrontService: BrandStorefrontService,
        private brandSwitcherService: BrandSwitcherService,
    ) {}

    /**
     * A BRAND channel appears in the switcher only if its seller's storefront
     * has showInStoreSwitcher = true. CITY/DIRECT channels are unaffected.
     */
    private isHiddenBrand(type: ChannelTypeValue, storefront?: BrandStorefront): boolean {
        if (type !== 'BRAND') return false;
        return !storefront || !storefront.showInStoreSwitcher;
    }

    /**
     * Map each channel id to its seller's BrandStorefront row (storefront is
     * keyed to Seller, not Channel). One query for channel→seller, one for the
     * storefronts. Avoids N+1.
     */
    private async resolveStorefrontsByChannel(
        ctx: RequestContext,
        channels: Channel[],
    ): Promise<Map<string, BrandStorefront>> {
        const channelIds = channels.map(c => c.id);
        if (channelIds.length === 0) return new Map();
        const withSeller = await this.connection
            .getRepository(ctx, Channel)
            .find({ where: { id: In(channelIds as any) }, relations: ['seller'] });
        const channelToSeller = new Map<string, string>();
        for (const ch of withSeller) {
            if (ch.seller) channelToSeller.set(String(ch.id), String(ch.seller.id));
        }
        const sellerStorefronts = await this.brandStorefrontService.findBySellerIds(
            ctx,
            [...channelToSeller.values()],
        );
        const byChannel = new Map<string, BrandStorefront>();
        for (const [channelId, sellerId] of channelToSeller) {
            const sf = sellerStorefronts.get(sellerId);
            if (sf) byChannel.set(channelId, sf);
        }
        return byChannel;
    }

    /**
     * Map channelId → sellerId for a set of channels (one query). Channels
     * with no seller are omitted.
     */
    private async resolveSellerByChannel(
        ctx: RequestContext,
        channels: Channel[],
    ): Promise<Map<string, string>> {
        const channelIds = channels.map(c => c.id);
        if (channelIds.length === 0) return new Map();
        const withSeller = await this.connection
            .getRepository(ctx, Channel)
            .find({ where: { id: In(channelIds as any) }, relations: ['seller'] });
        const map = new Map<string, string>();
        for (const ch of withSeller) {
            if (ch.seller) map.set(String(ch.id), String(ch.seller.id));
        }
        return map;
    }

    /**
     * Batch-load postal codes for a set of channel ids → channelId → PostalData.
     * One query, no N+1.
     */
    private async buildPostalMap(
        ctx: RequestContext,
        channelIds: Array<string | number>,
    ): Promise<Map<string, PostalData>> {
        const map = new Map<string, PostalData>();
        if (channelIds.length === 0) return map;
        const allPostalCodes = await this.connection
            .getRepository(ctx, PostalCode)
            .createQueryBuilder('pc')
            .innerJoin('pc.channels', 'ch')
            .addSelect('ch.id', 'channelId')
            .where('ch.id IN (:...channelIds)', { channelIds })
            .getRawAndEntities();
        for (let i = 0; i < allPostalCodes.entities.length; i++) {
            const pc = allPostalCodes.entities[i];
            const chId = String(allPostalCodes.raw[i].channelId ?? allPostalCodes.raw[i].ch_id);
            if (!map.has(chId)) map.set(chId, { codes: [], hasAnywhere: false });
            const entry = map.get(chId)!;
            if (pc.isAnywhere) entry.hasAnywhere = true;
            entry.codes.push(pc.code);
        }
        return map;
    }

    /**
     * Decide one channel's availability given its storefront + postal data.
     * Single source of truth for the OPENING_SOON lock, postal check, token
     * gating and message text — shared by getAvailableChannels and the app
     * switcher so their rules never drift.
     */
    private buildAvailabilityEntry(
        channel: Channel,
        channelType: ChannelTypeValue,
        storefront: BrandStorefront | undefined,
        postalData: PostalData | undefined,
        postalCode: string,
    ): ChannelAvailability {
        const launchStatus: BrandLaunchStatus = storefront?.launchStatus ?? 'LAUNCHED';
        const bannerImage = storefront?.bannerImage ?? null;
        const postalCodeAvailable = postalData
            ? postalData.hasAnywhere || postalData.codes.includes(postalCode)
            : false;
        // Pure decision (launch gate → pincode → token rule) lives in
        // functions/availability so it can be unit tested without a DB.
        const decision = decideAvailability({ channelType, launchStatus, postalCodeAvailable });
        return {
            id: channel.id.toString(),
            code: channel.code,
            token: (decision.hasToken ? channel.token : null) as any,
            name: channel.code,
            isAvailable: decision.isAvailable,
            message: decision.message,
            type: channelType,
            launchStatus,
            bannerImage,
        };
    }

    /**
     * Get available channels for customer's saved address
     */
    async getAvailableChannelsForActiveOrder(
        ctx: RequestContext,
        manualPostalCode?: string,
        channelTypeFilter?: ChannelTypeValue,
        sellerId?: string,
        country?: string,
    ): Promise<ChannelAvailability[]> {
        const postalCode = await this.resolvePostalCode(ctx, manualPostalCode);
        // If no postal code found, return all channels as unavailable
        if (!postalCode) {
            return this.getAllChannelsUnavailable(ctx, channelTypeFilter, sellerId, country);
        }
        return this.getAvailableChannels(ctx, postalCode, channelTypeFilter, sellerId, country);
    }

    /**
     * Postal code for the request: the manual one if given, else the active
     * customer's default shipping address, else undefined.
     */
    private async resolvePostalCode(
        ctx: RequestContext,
        manualPostalCode?: string,
    ): Promise<string | undefined> {
        if (manualPostalCode) return manualPostalCode;
        if (!ctx.activeUserId) return undefined;
        const customer = await this.customerService.findOne(ctx, ctx.activeUserId);
        if (!customer?.addresses || customer.addresses.length === 0) return undefined;
        const defaultAddress =
            customer.addresses.find(addr => addr.defaultShippingAddress) || customer.addresses[0];
        return defaultAddress?.postalCode;
    }

    /**
     * Brand cards for the CURRENT app's switcher. Host app = the seller that
     * owns ctx.channel (the token the app booted on). Returns that host's
     * allowlisted brands, ordered, each brand carrying its channels already
     * availability-resolved. Falls back to all published switcher brands when
     * the host channel has no seller or no configured allowlist (safe "master
     * app" behavior).
     */
    async getSwitcherBrandsForActiveOrder(
        ctx: RequestContext,
        manualPostalCode?: string,
    ): Promise<SwitcherBrand[]> {
        const postalCode = await this.resolvePostalCode(ctx, manualPostalCode);
        return this.getSwitcherBrandsForHost(ctx, postalCode);
    }

    /**
     * Seller (brand) that owns the request's active channel, derived from the
     * vendure-token. Null when the channel has no seller (e.g. default channel).
     * Lets a caller default to "my own brand" without passing a sellerId.
     */
    async resolveActiveSellerId(ctx: RequestContext): Promise<string | null> {
        const channel = await this.connection
            .getRepository(ctx, Channel)
            .findOne({ where: { id: ctx.channelId as any }, relations: ['seller'] });
        return channel?.seller ? String(channel.seller.id) : null;
    }

    /**
     * Look up a brand by its Seller name so clients don't have to hardcode a
     * numeric sellerId. Exact match, case-insensitive (MySQL ci collation),
     * whitespace trimmed. Soft-deleted sellers are excluded.
     *
     * Seller.name carries no unique constraint, so a duplicate name is
     * genuinely ambiguous — we throw rather than silently pick one, which
     * would bind the caller to the wrong brand.
     *
     * @returns the seller id, or null when no live seller has that name.
     */
    async resolveSellerIdByName(ctx: RequestContext, name: string): Promise<string | null> {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const sellers = await this.connection.getRepository(ctx, Seller).find({
            where: { name: trimmed, deletedAt: IsNull() },
        });
        if (sellers.length === 0) return null;
        if (sellers.length > 1) {
            throw new UserInputError(
                `More than one brand is named "${trimmed}"; pass sellerId instead.`,
            );
        }
        return String(sellers[0].id);
    }

    /**
     * For each seller, does ANY of its enabled channels deliver to the pincode?
     * Used to grey out brands the customer can't order from in the switcher.
     * One channel query + one postal query; no N+1. Sellers with no serving
     * channel map to false; sellers not in the map should be treated as false.
     */
    async resolveSellerAvailability(
        ctx: RequestContext,
        sellerIds: string[],
        postalCode: string,
    ): Promise<Map<string, boolean>> {
        const avail = new Map<string, boolean>();
        const wanted = new Set(sellerIds.map(String));
        if (wanted.size === 0) return avail;
        const channels = await this.channelService.findAll(ctx);
        const eligible = channels.items.filter(channel => {
            if (channel.code === '__default_channel__') return false;
            return ((channel.customFields as any)?.enabled ?? true) as boolean;
        });
        const sellerByChannel = await this.resolveSellerByChannel(ctx, eligible);
        const relevant = eligible.filter(c => wanted.has(sellerByChannel.get(String(c.id)) ?? ''));
        const postalMap = await this.buildPostalMap(ctx, relevant.map(c => c.id));
        for (const channel of relevant) {
            const sellerId = sellerByChannel.get(String(channel.id))!;
            const pd = postalMap.get(String(channel.id));
            const serves = pd ? pd.hasAnywhere || pd.codes.includes(postalCode) : false;
            if (serves) avail.set(sellerId, true);
            else if (!avail.has(sellerId)) avail.set(sellerId, false);
        }
        return avail;
    }

    /**
     * Which of the given sellers own at least one channel typed "International"?
     * Powers the switcher's country toggle: only worldwide brands (South Mithai)
     * get it; India-only brands (Kaaikani, Swad, Sip) don't. One channel query.
     */
    async resolveSellersWithInternational(
        ctx: RequestContext,
        sellerIds: string[],
    ): Promise<Set<string>> {
        const withIntl = new Set<string>();
        const wanted = new Set(sellerIds.map(String));
        if (wanted.size === 0) return withIntl;
        const channels = await this.channelService.findAll(ctx);
        const intlChannels = channels.items.filter(
            channel =>
                channel.code !== '__default_channel__' &&
                isInternationalType((channel.customFields as any)?.type),
        );
        const sellerByChannel = await this.resolveSellerByChannel(ctx, intlChannels);
        for (const channel of intlChannels) {
            const sellerId = sellerByChannel.get(String(channel.id));
            if (sellerId && wanted.has(sellerId)) withIntl.add(sellerId);
        }
        return withIntl;
    }

    /**
     * Deliverable channels (with entry tokens) per seller for a pincode, in ONE
     * channel + one postal query — the batched form of brandChannels for the
     * whole switcher. country narrows region (IN → non-International, else →
     * International only); omit for all regions. Only channels that actually
     * serve the pincode are returned, so a brand with none maps to [] (grey it).
     */
    async resolveChannelsBySellers(
        ctx: RequestContext,
        sellerIds: string[],
        postalCode: string,
        country?: string,
    ): Promise<Map<string, BrandChannel[]>> {
        const out = new Map<string, BrandChannel[]>();
        const wanted = new Set(sellerIds.map(String));
        if (wanted.size === 0) return out;
        const channels = await this.channelService.findAll(ctx);
        let eligible = channels.items.filter(
            channel =>
                channel.code !== '__default_channel__' &&
                (((channel.customFields as any)?.enabled ?? true) as boolean),
        );
        const sellerByChannel = await this.resolveSellerByChannel(ctx, eligible);
        eligible = eligible.filter(c => wanted.has(sellerByChannel.get(String(c.id)) ?? ''));
        if (country) {
            eligible = eligible.filter(c =>
                typeMatchesRegion((c.customFields as any)?.type, country),
            );
        }
        if (eligible.length === 0) return out;
        const storefrontMap = await this.resolveStorefrontsByChannel(ctx, eligible);
        const postalMap = await this.buildPostalMap(ctx, eligible.map(c => c.id));
        for (const channel of eligible) {
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as ChannelTypeValue;
            const entry = this.buildAvailabilityEntry(
                channel,
                channelType,
                storefrontMap.get(String(channel.id)),
                postalMap.get(String(channel.id)),
                postalCode,
            );
            if (!entry.isAvailable) continue;
            const sellerId = sellerByChannel.get(String(channel.id))!;
            if (!out.has(sellerId)) out.set(sellerId, []);
            out.get(sellerId)!.push({
                id: entry.id,
                code: entry.code,
                name: entry.name,
                token: entry.token,
                type: entry.type,
            });
        }
        return out;
    }

    async getSwitcherBrandsForHost(
        ctx: RequestContext,
        postalCode?: string,
    ): Promise<SwitcherBrand[]> {
        // 1. Host seller = owner of the channel this request booted on.
        const hostSellerId = await this.resolveActiveSellerId(ctx);

        // 2. Ordered allowlist for this host; empty → fall back to all published.
        let orderedTargetIds = hostSellerId
            ? await this.brandSwitcherService.findTargetSellerIds(ctx, hostSellerId)
            : [];
        if (orderedTargetIds.length === 0) {
            const published = await this.brandStorefrontService.findPublished(ctx);
            orderedTargetIds = published.map(p => String(p.seller.id));
        }
        if (orderedTargetIds.length === 0) return [];
        const orderIndex = new Map<string, number>();
        orderedTargetIds.forEach((id, i) => orderIndex.set(id, i));
        const allowedSet = new Set(orderedTargetIds);

        // 3. Eligible channels (CITY/BRAND, enabled, non-default) whose seller is allowed.
        const channels = await this.channelService.findAll(ctx);
        const eligible = channels.items.filter(channel => {
            if (channel.code === '__default_channel__') return false;
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as string;
            if (channelType !== 'CITY' && channelType !== 'BRAND') return false;
            return ((channel.customFields as any)?.enabled ?? true) as boolean;
        });
        const sellerByChannel = await this.resolveSellerByChannel(ctx, eligible);
        const allowedChannels = eligible.filter(c => {
            const sid = sellerByChannel.get(String(c.id));
            return sid != null && allowedSet.has(sid);
        });
        if (allowedChannels.length === 0) return [];

        // 4. Storefront content + postal codes for the allowed channels.
        const storefrontMap = await this.resolveStorefrontsByChannel(ctx, allowedChannels);
        const postalMap = await this.buildPostalMap(ctx, allowedChannels.map(c => c.id));

        // 5. Group availability-resolved channels by their seller (brand).
        const channelsBySeller = new Map<string, ChannelAvailability[]>();
        for (const channel of allowedChannels) {
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as ChannelTypeValue;
            const storefront = storefrontMap.get(String(channel.id));
            const entry = this.buildAvailabilityEntry(
                channel,
                channelType,
                storefront,
                postalMap.get(String(channel.id)),
                postalCode ?? '',
            );
            const sid = sellerByChannel.get(String(channel.id))!;
            if (!channelsBySeller.has(sid)) channelsBySeller.set(sid, []);
            channelsBySeller.get(sid)!.push(entry);
        }

        // 6. Brand-level content: seller name + storefront (banner, launch status).
        const sellerIds = [...channelsBySeller.keys()];
        const sellerRows = await this.connection
            .getRepository(ctx, Seller)
            .find({ where: { id: In(sellerIds as any) } });
        const sellerName = new Map(sellerRows.map(s => [String(s.id), s.name]));
        const storefrontBySeller = await this.brandStorefrontService.findBySellerIds(ctx, sellerIds);

        // 7. Emit brands in the host's configured order.
        return sellerIds
            .sort((a, b) => (orderIndex.get(a) ?? 9999) - (orderIndex.get(b) ?? 9999))
            .map(sid => {
                const sf = storefrontBySeller.get(sid);
                return {
                    seller: { id: sid, name: sellerName.get(sid) ?? sid },
                    bannerImage: sf?.bannerImage ?? null,
                    launchStatus: (sf?.launchStatus ?? 'LAUNCHED') as BrandLaunchStatus,
                    channels: channelsBySeller.get(sid)!,
                };
            });
    }

    /**
     * Get all channels with availability status based on postal code.
     * Excludes the default channel.
     * Batch-loads postal codes for all channels in a single query (avoids N+1).
     */
    async getAvailableChannels(
        ctx: RequestContext,
        postalCode: string,
        channelTypeFilter?: ChannelTypeValue,
        sellerId?: string,
        country?: string,
    ): Promise<ChannelAvailability[]> {
        const cacheKey = channelAvailKey(
            postalCode,
            channelTypeFilter,
            sellerId ? String(sellerId) : undefined,
            country,
        );
        const cached = (await this.cacheService.get(cacheKey)) as ChannelAvailability[] | undefined;
        if (cached) {
            return cached;
        }

        // 1. Get all channels
        const channels = await this.channelService.findAll(ctx);

        // 2. Filter eligible channels first (before any DB queries)
        let eligibleChannels = channels.items.filter(channel => {
            if (channel.code === '__default_channel__') return false;
            const channelEnabled = ((channel.customFields as any)?.enabled ?? true) as boolean;
            if (!channelEnabled) return false;
            // Seller-scoped drill-down: return ALL of that seller's enabled
            // channels regardless of type (seller filter applied below). This is
            // the "tap a brand → show its channels" path; type gate is skipped so
            // a mistyped channel type can't silently drop the brand's channel.
            if (sellerId) return true;
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as string;
            // Legacy contract: only CITY and BRAND are eligible here; DIRECT is
            // hard-blocked. DIRECT/brand switching now lives in brandChannels/
            // switcherBrands, so this deprecated query keeps its original behavior.
            if (channelType !== 'CITY' && channelType !== 'BRAND') return false;
            // Within CITY/BRAND, apply the optional type filter.
            if (channelTypeFilter && channelType !== channelTypeFilter) return false;
            return true;
        });

        // 2b. Narrow to a single seller, then to the customer's region: outside
        // India → INTERNATIONAL channels only; India → non-INTERNATIONAL. This is
        // how one seller's National vs International channels get separated.
        if (sellerId) {
            const sellerByChannel = await this.resolveSellerByChannel(ctx, eligibleChannels);
            eligibleChannels = eligibleChannels.filter(
                c => sellerByChannel.get(String(c.id)) === String(sellerId),
            );
            // Coverage filter ONLY when the app declares a country. No country =
            // show every region (National + International) so the app can ask the
            // user which store to enter. With a country, narrow to that region.
            if (country) {
                eligibleChannels = eligibleChannels.filter(c =>
                    typeMatchesRegion((c.customFields as any)?.type, country),
                );
            }
        }

        if (eligibleChannels.length === 0) return [];

        // 3. Batch-load postal codes AND brand storefronts for ALL eligible channels
        const channelIds = eligibleChannels.map(c => c.id);
        const storefrontMap = await this.resolveStorefrontsByChannel(ctx, eligibleChannels);
        const channelPostalMap = await this.buildPostalMap(ctx, channelIds);

        // 4. Build availability results (no more per-channel queries)
        const result: ChannelAvailability[] = [];
        for (const channel of eligibleChannels) {
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as ChannelTypeValue;
            const storefront = storefrontMap.get(String(channel.id));
            // Curation: hide BRANDs not flagged for the switcher — but a
            // seller-scoped drill-down is explicit, so curation is skipped there.
            if (!sellerId && this.isHiddenBrand(channelType, storefront)) continue;
            result.push(
                this.buildAvailabilityEntry(
                    channel,
                    channelType,
                    storefront,
                    channelPostalMap.get(String(channel.id)),
                    postalCode,
                ),
            );
        }

        // Seller drill-down (sellerId set): a pincode was supplied, so return
        // ONLY the channels that actually deliver there — drop the rest instead
        // of listing them unavailable. The global list (no sellerId) keeps every
        // channel with its availability flag for "pick your city" screens.
        const finalResult = sellerId ? result.filter(entry => entry.isAvailable) : result;
        if (sellerId && finalResult.length === 0) {
            // No channel of this brand serves the pincode → business error, not [].
            throw new UserInputError(
                'Service Not Available for the Given Pincode. For enquiries, please contact customer care.',
            );
        }

        await this.cacheService.set(cacheKey, finalResult as any, {
            ttl: CHANNEL_AVAIL_TTL_MS,
            tags: [CHANNEL_AVAIL_TAG_ALL, POSTAL_TAG_ALL],
        });
        return finalResult;
    }

    /**
     * Invalidate all channel availability cache entries.
     * Call when channels are added/removed/enabled/disabled.
     * Postal-code edits already invalidate via the shared `postal-codes:all` tag.
     */
    async invalidateAvailabilityCache(): Promise<void> {
        await this.cacheService.invalidateTags([CHANNEL_AVAIL_TAG_ALL]);
        Logger.debug('[ChannelAvailabilityService] Cache cleared');
    }

    /**
     * Return all channels as unavailable (when no postal code is provided)
     * Excludes the default channel
     */
    private async getAllChannelsUnavailable(
        ctx: RequestContext,
        channelTypeFilter?: ChannelTypeValue,
        sellerId?: string,
        country?: string,
    ): Promise<ChannelAvailability[]> {
        const channels = await this.channelService.findAll(ctx);

        let eligible = channels.items.filter((channel) => {
            // Skip the default channel
            if (channel.code === '__default_channel__') {
                return false;
            }
            // Skip disabled channels completely
            const channelEnabled = ((channel.customFields as any)?.enabled ?? true) as boolean;
            if (!channelEnabled) {
                return false;
            }
            // Seller-scoped drill-down: all of that seller's enabled channels
            // regardless of type (seller filter applied below).
            if (sellerId) return true;
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as string;
            // Legacy contract: only CITY and BRAND are eligible here; DIRECT is
            // hard-blocked. DIRECT/brand switching now lives in brandChannels/
            // switcherBrands, so this deprecated query keeps its original behavior.
            if (channelType !== 'CITY' && channelType !== 'BRAND') return false;
            // Within CITY/BRAND, apply the optional type filter.
            if (channelTypeFilter && channelType !== channelTypeFilter) return false;
            return true;
        });

        if (sellerId) {
            const sellerByChannel = await this.resolveSellerByChannel(ctx, eligible);
            eligible = eligible.filter(c => sellerByChannel.get(String(c.id)) === String(sellerId));
            if (country) {
                eligible = eligible.filter(c =>
                    typeMatchesRegion((c.customFields as any)?.type, country),
                );
            }
        }

        const storefrontMap = await this.resolveStorefrontsByChannel(ctx, eligible);

        const result: ChannelAvailability[] = [];
        for (const channel of eligible) {
            const channelType = ((channel.customFields as any)?.type || 'BRAND') as ChannelTypeValue;
            const storefront = storefrontMap.get(String(channel.id));
            if (!sellerId && this.isHiddenBrand(channelType, storefront)) continue;
            const launchStatus: BrandLaunchStatus = storefront?.launchStatus ?? 'LAUNCHED';
            const isOpeningSoon = launchStatus === 'OPENING_SOON';
            result.push({
                id: channel.id.toString(),
                code: channel.code,
                token: isOpeningSoon ? (null as any) : channel.token,
                name: channel.code,
                isAvailable: false,
                message: isOpeningSoon
                    ? 'Opening soon'
                    : 'Please set shipping address to see available brands',
                type: channelType,
                launchStatus,
                bannerImage: storefront?.bannerImage ?? null,
            });
        }
        return result;
    }
}
