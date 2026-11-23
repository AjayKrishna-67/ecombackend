import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    Channel,
    CollectionEvent,
    EventBus,
    ID,
    Logger,
    ProductEvent,
    RequestContext,
    TransactionalConnection,
    User,
} from '@vendure/core';
import {
    AvailabilityChangeField,
    AvailabilityChangeSource,
    AvailabilityTargetType,
} from '../constants';
import { AvailabilityTargetChangeLog } from '../entities/availability-target-change-log.entity';

const loggerCtx = 'ScheduledAvailability';

interface RecordChangeArgs {
    ctx: RequestContext;
    targetType: AvailabilityTargetType;
    targetId: ID;
    field: AvailabilityChangeField;
    newValue: boolean;
}

/**
 * Records who flipped a product's `enabled` or a collection's `isPrivate`.
 *
 * Only writes when the relevant boolean is actually present in the event input.
 * ProductEvent fires on every price sync, import and stock update in this
 * project, so logging unconditionally would add millions of irrelevant rows;
 * availability flips are rare by comparison.
 */
@Injectable()
export class AvailabilityChangeLogService implements OnModuleInit {
    constructor(
        private eventBus: EventBus,
        private connection: TransactionalConnection,
    ) {}

    onModuleInit(): void {
        this.eventBus.ofType(ProductEvent).subscribe(event => {
            const newValue = readChangedBoolean(event.input, 'enabled');
            if (newValue === undefined) {
                return;
            }
            void this.recordChange({
                ctx: event.ctx,
                targetType: 'Product',
                targetId: event.entity.id,
                field: 'enabled',
                newValue,
            });
        });

        this.eventBus.ofType(CollectionEvent).subscribe(event => {
            const newValue = readChangedBoolean(event.input, 'isPrivate');
            if (newValue === undefined) {
                return;
            }
            void this.recordChange({
                ctx: event.ctx,
                targetType: 'Collection',
                targetId: event.entity.id,
                field: 'isPrivate',
                newValue,
            });
        });
    }

    /** Latest recorded flip for a target, or undefined if we never saw one. */
    async findLatestChange(
        ctx: RequestContext,
        targetType: AvailabilityTargetType,
        targetId: ID,
    ): Promise<AvailabilityTargetChangeLog | undefined> {
        const row = await this.connection
            .getRepository(ctx, AvailabilityTargetChangeLog)
            .findOne({
                where: { targetType, targetId },
                order: { createdAt: 'DESC' },
                relations: { changedByUser: true },
            });
        return row ?? undefined;
    }

    /**
     * Never lets a logging failure break the catalogue write that triggered it.
     * An audit gap is bad; a failed product update because the audit table was
     * locked is worse.
     */
    private async recordChange({
        ctx,
        targetType,
        targetId,
        field,
        newValue,
    }: RecordChangeArgs): Promise<void> {
        try {
            const source: AvailabilityChangeSource = ctx.activeUserId ? 'ADMIN' : 'SYSTEM';
            await this.connection.getRepository(ctx, AvailabilityTargetChangeLog).save(
                new AvailabilityTargetChangeLog({
                    targetType,
                    targetId,
                    field,
                    newValue,
                    source,
                    // Partial relation objects set the foreign key without a load.
                    channel: ctx.channelId ? ({ id: ctx.channelId } as Channel) : null,
                    changedByUser: ctx.activeUserId ? ({ id: ctx.activeUserId } as User) : null,
                }),
            );
        } catch (err: unknown) {
            Logger.error(
                `Failed to log availability change for ${targetType} ${String(targetId)}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                loggerCtx,
            );
        }
    }
}

/**
 * Reads a boolean field from an event input. Returns undefined when the input
 * is a bare ID (deletions) or when the field was not part of this update.
 */
function readChangedBoolean(input: unknown, field: string): boolean | undefined {
    if (!input || typeof input !== 'object') {
        return undefined;
    }
    const value = (input as Record<string, unknown>)[field];
    return typeof value === 'boolean' ? value : undefined;
}
