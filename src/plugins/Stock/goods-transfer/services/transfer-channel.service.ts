import { Injectable } from '@nestjs/common';
import {
    Channel,
    ForbiddenError,
    ID,
    RequestContext,
    StockLocation,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { DEFAULT_CHANNEL_CODE } from '@vendure/common/lib/shared-constants';

import { pickSharedStockLocation } from './goods-transfer.helpers';

/**
 * Destination selection + StockLocation resolution.
 *
 * The DESTINATION is any branch except the one the user is working in. Channel
 * MEMBERSHIP is deliberately not part of the rule: an admin belongs to exactly one
 * branch (SPEC §3), and requiring membership of the receiving branch would hand that
 * admin a login to it. Every rule is re-checked server-side from the session, so a
 * hand-crafted request cannot bypass the dropdown.
 *
 * Reading and acting on a transfer IS still restricted — assertChannelMember and
 * assertSourceChannel below keep each branch to its own documents.
 *
 * StockLocation = the one associated with the channel via the existing Vendure
 * channel configuration. Exactly one required; 0 or >1 blocks with an
 * Admin-Team-facing message. The module never guesses.
 */
@Injectable()
export class TransferChannelService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Server-side validation of a chosen destination — the dropdown is convenience,
     * this is the rule:
     *  ① destination ≠ source (entry branch and receiving branch must differ)
     *  ② destination exists
     *  ③ destination is not the default channel
     * Returns the destination Channel entity on success.
     */
    async validateDestination(ctx: RequestContext, destinationChannelId: ID): Promise<Channel> {
        const sourceChannelId = ctx.channelId;
        if (String(destinationChannelId) === String(sourceChannelId)) {
            throw new UserInputError('Ship-To channel must be different from the entry (source) channel');
        }
        const destination = await this.connection
            .getRepository(ctx, Channel)
            .findOne({ where: { id: destinationChannelId as any } });
        if (!destination) {
            throw new UserInputError(`Destination channel ${destinationChannelId} not found`);
        }
        if (destination.code === DEFAULT_CHANNEL_CODE) {
            throw new UserInputError('Goods cannot be transferred to the default channel — pick a branch');
        }
        return destination;
    }

    /**
     * The same three rules, read from the other end: an item request names the branch
     * being ASKED to send, and the caller is the one that will receive.
     *
     * Separate from `validateDestination` only so the message names the field the user
     * actually filled in. Telling someone raising a request that their "Ship-To channel"
     * is wrong describes a screen they were never on.
     */
    async validateRequestSource(ctx: RequestContext, sourceChannelId: ID): Promise<Channel> {
        if (String(sourceChannelId) === String(ctx.channelId)) {
            throw new UserInputError('Request From branch must be different from your own branch');
        }
        const source = await this.connection
            .getRepository(ctx, Channel)
            .findOne({ where: { id: sourceChannelId as any } });
        if (!source) {
            throw new UserInputError(`Channel ${sourceChannelId} not found`);
        }
        if (source.code === DEFAULT_CHANNEL_CODE) {
            throw new UserInputError('Items cannot be requested from the default channel — pick a branch');
        }
        return source;
    }

    /** Membership guard for reads/actions: ctx channel must be source or destination. */
    assertChannelMember(ctx: RequestContext, transfer: { sourceChannelId: ID; destinationChannelId: ID }): void {
        const cid = String(ctx.channelId);
        if (cid !== String(transfer.sourceChannelId) && cid !== String(transfer.destinationChannelId)) {
            throw new ForbiddenError();
        }
    }

    /** Destination-side-only actions (withdrawing a request you raised). */
    assertDestinationChannel(ctx: RequestContext, transfer: { destinationChannelId: ID }): void {
        if (String(ctx.channelId) !== String(transfer.destinationChannelId)) {
            throw new ForbiddenError();
        }
    }

    /** Source-side-only actions (create/edit/confirm/dispatch). */
    assertSourceChannel(ctx: RequestContext, transfer: { sourceChannelId: ID }): void {
        if (String(ctx.channelId) !== String(transfer.sourceChannelId)) {
            throw new ForbiddenError();
        }
    }

    /**
     * T2 (updated per business clarification): the StockLocation REPRESENTS the
     * channel — resolved by NAME MATCH, the EXISTING project convention (the
     * same rule production bulk-sync uses, because one location can serve
     * several channels and a channel can also carry extra category locations).
     *
     * Resolution order:
     *  1. Among the channel's assigned locations, the one whose NAME matches
     *     the channel code (case-insensitive) — e.g. channel "Kochi" → location "Kochi".
     *  2. No name match but EXACTLY ONE location assigned → that one
     *     (clean 1:1 setups regardless of naming).
     *  3. Otherwise → block with a clear Admin-Team message. Never guess.
     */
    async resolveStockLocationForChannel(ctx: RequestContext, channelId: ID): Promise<StockLocation> {
        const channel = await this.connection
            .getRepository(ctx, Channel)
            .findOne({ where: { id: channelId as any } });
        if (!channel) {
            throw new UserInputError(`Channel with id ${channelId} not found`);
        }
        const locations = await this.connection
            .getRepository(ctx, StockLocation)
            .createQueryBuilder('location')
            .innerJoin('location.channels', 'channel', 'channel.id = :channelId', { channelId })
            .getMany();

        const norm = (s: string) => (s || '').trim().toLowerCase();
        const nameMatches = locations.filter(l => norm(l.name) === norm(channel.code));
        if (nameMatches.length === 1) {
            return nameMatches[0];
        }
        if (nameMatches.length === 0 && locations.length === 1) {
            return locations[0];
        }
        if (locations.length === 0) {
            throw new UserInputError(
                `Channel "${channel.code}" has no Stock Location assigned. ` +
                    `The Admin Team must create/assign a Stock Location named "${channel.code}" for this channel.`,
            );
        }
        throw new UserInputError(
            `Channel "${channel.code}" has ${locations.length} Stock Locations assigned ` +
                `(${locations.map(l => l.name).join(', ')}) but none named "${channel.code}". ` +
                `The Admin Team must name the channel's own Stock Location "${channel.code}" (project convention).`,
        );
    }

    /**
     * The StockLocation both branches draw from, or null when they keep separate stock.
     *
     * Madurai, Coimbatore, Salem and Trichy sell from ONE stock base: the Madurai
     * location is assigned to every one of those channels. Goods moved between two
     * such branches were already counted in that base before they left, so posting
     * them again on receipt counted the same goods twice — and, because pooled
     * availability is summed across every location, made a product that was sold out
     * at Madurai look available in every branch.
     *
     * When the two channels share a location, the transfer is stock-neutral and is
     * pinned here instead, so the damage deduction and the stock shown on the screen
     * both read the base the goods are actually counted in. Branches with no location
     * in common (e.g. Idukki on its own "kochi" location) keep the old behaviour.
     *
     * Several shared locations (the category locations — Fruit, Offer, … — are
     * assigned to most branches too) are narrowed by pickSharedStockLocation.
     */
    async resolveSharedStockLocation(
        ctx: RequestContext,
        sourceChannelId: ID,
        destinationChannelId: ID,
    ): Promise<StockLocation | null> {
        const shared = await this.connection
            .getRepository(ctx, StockLocation)
            .createQueryBuilder('location')
            .innerJoin('location.channels', 'src', 'src.id = :sourceChannelId', { sourceChannelId })
            .innerJoin('location.channels', 'dst', 'dst.id = :destinationChannelId', { destinationChannelId })
            .leftJoinAndSelect('location.channels', 'assigned')
            .getMany();
        if (shared.length === 0) {
            return null;
        }
        const [sourceCode, destinationCode] = await Promise.all([
            this.getChannelCode(ctx, sourceChannelId),
            this.getChannelCode(ctx, destinationChannelId),
        ]);
        const picked = pickSharedStockLocation(
            shared.map(l => ({
                id: l.id,
                name: l.name,
                channelCount: (l.channels ?? []).filter(c => c.code !== DEFAULT_CHANNEL_CODE).length,
            })),
            sourceCode,
            destinationCode,
        );
        return shared.find(l => String(l.id) === String(picked.id)) ?? null;
    }

    /**
     * A channel's code, for display and for naming a branch in an error message.
     *
     * Lives here rather than on each consumer so a branch is looked up one way. Every
     * user-facing message that mentions a branch must resolve its name through this —
     * a hardcoded branch name reads correctly in the branch it was written for and
     * lies in every other one.
     *
     * Returns '' for a channel that no longer exists, so a message degrades to being
     * vague rather than throwing on top of whatever already went wrong.
     */
    async getChannelCode(ctx: RequestContext, channelId: ID): Promise<string> {
        const channel = await this.connection
            .getRepository(ctx, Channel)
            .findOne({ where: { id: channelId as any } });
        return channel?.code ?? '';
    }
}
