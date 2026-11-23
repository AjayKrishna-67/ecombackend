import { Injectable } from '@nestjs/common';
import {
    CollectionService,
    EntityNotFoundError,
    ID,
    InternalServerError,
    ProductService,
    RequestContext,
} from '@vendure/core';
import { AvailabilityTargetType } from '../constants';
import { AvailabilityTargetChangeLog } from '../entities/availability-target-change-log.entity';
import { AvailabilityChangeLogService } from './availability-change-log.service';

export type ApplyOutcome = 'APPLIED' | 'NOOP';

export interface ApplyAvailabilityResult {
    outcome: ApplyOutcome;
    /** Populated on NOOP: why nothing was written, and who is responsible. */
    note: string | null;
}

interface ApplyAvailabilityArgs {
    ctx: RequestContext;
    targetType: AvailabilityTargetType;
    targetId: ID;
    shouldBeAvailable: boolean;
}

interface TargetState {
    isAvailable: boolean;
    updatedAt: Date;
}

/**
 * Translates "make this available / unavailable" into the write each target
 * type actually needs, and reports whether anything changed.
 *
 * The two types do not share a field. Product carries `enabled`; Collection has
 * no such column and instead carries `isPrivate`, which runs in the opposite
 * direction. Centralising that here keeps the polarity inversion in one place
 * instead of scattered across the sweeper.
 */
@Injectable()
export class TargetApplierRegistry {
    constructor(
        private productService: ProductService,
        private collectionService: CollectionService,
        private changeLogService: AvailabilityChangeLogService,
    ) {}

    async applyAvailability({
        ctx,
        targetType,
        targetId,
        shouldBeAvailable,
    }: ApplyAvailabilityArgs): Promise<ApplyAvailabilityResult> {
        const currentState = await this.readState(ctx, targetType, targetId);
        if (currentState.isAvailable === shouldBeAvailable) {
            return {
                outcome: 'NOOP',
                note: await this.explainNoOp({
                    ctx,
                    targetType,
                    targetId,
                    shouldBeAvailable,
                    updatedAt: currentState.updatedAt,
                }),
            };
        }
        await this.writeState(ctx, targetType, targetId, shouldBeAvailable);
        return { outcome: 'APPLIED', note: null };
    }

    private async readState(
        ctx: RequestContext,
        targetType: AvailabilityTargetType,
        targetId: ID,
    ): Promise<TargetState> {
        if (targetType === 'Product') {
            const product = await this.productService.findOne(ctx, targetId);
            if (!product) {
                throw new Error(describeMissingTarget(ctx, 'Product', targetId));
            }
            return { isAvailable: product.enabled, updatedAt: product.updatedAt };
        }
        if (targetType === 'Collection') {
            const collection = await this.collectionService.findOne(ctx, targetId);
            if (!collection) {
                throw new Error(describeMissingTarget(ctx, 'Collection', targetId));
            }
            // Collection has no `enabled` column. `isPrivate` is its inverse.
            return { isAvailable: !collection.isPrivate, updatedAt: collection.updatedAt };
        }
        throw new InternalServerError(`Unsupported availability target type: ${String(targetType)}`);
    }

    /**
     * Always goes through the service, never the repository. ProductService.update
     * publishes a ProductEvent, which is what drives the search-index update.
     * A direct repository save would leave the row disabled while the product
     * stayed visible in shop search -- with no error raised anywhere.
     */
    private async writeState(
        ctx: RequestContext,
        targetType: AvailabilityTargetType,
        targetId: ID,
        shouldBeAvailable: boolean,
    ): Promise<void> {
        if (targetType === 'Product') {
            await this.productService.update(ctx, { id: targetId, enabled: shouldBeAvailable });
            return;
        }
        await this.collectionService.update(ctx, { id: targetId, isPrivate: !shouldBeAvailable });
    }

    private async explainNoOp({
        ctx,
        targetType,
        targetId,
        shouldBeAvailable,
        updatedAt,
    }: {
        ctx: RequestContext;
        targetType: AvailabilityTargetType;
        targetId: ID;
        shouldBeAvailable: boolean;
        updatedAt: Date;
    }): Promise<string> {
        const state = shouldBeAvailable ? 'available' : 'unavailable';
        const latestChange = await this.changeLogService.findLatestChange(ctx, targetType, targetId);
        if (latestChange) {
            return `Already ${state}; set ${describeActor(latestChange)} at ${latestChange.createdAt.toISOString()}.`;
        }
        // No change record: this plugin was not installed when it was flipped.
        // updatedAt is stated as an unrelated-edit timestamp on purpose -- any
        // edit bumps it, so it must not be read as an availability change.
        return `Already ${state}; no change record. Target last modified at ${updatedAt.toISOString()} (any edit updates this, not necessarily the availability flip).`;
    }
}

/**
 * Says which channel the lookup happened in, and why that is usually the answer.
 *
 * `EntityNotFoundError` was used here first, but its message is the untranslated
 * key `error.entity-with-id-not-found` -- which is what ends up in `lastError`
 * and on the admin's screen, telling them nothing. The overwhelmingly common
 * cause is not deletion but channel membership: a target picked while browsing
 * one channel, scheduled against another.
 */
function describeMissingTarget(
    ctx: RequestContext,
    targetType: AvailabilityTargetType,
    targetId: ID,
): string {
    const channelCode = ctx.channel?.code ?? 'unknown';
    return (
        `${targetType} ${String(targetId)} was not found in channel "${channelCode}". ` +
        'It was either deleted, or it is not assigned to that channel.'
    );
}

function describeActor(change: AvailabilityTargetChangeLog): string {
    if (change.source === 'ADMIN' && change.changedByUser) {
        return `by user #${String(change.changedByUser.id)}`;
    }
    return change.source === 'ADMIN' ? 'by an administrator' : 'by a system process';
}
