import { Injectable } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { In, LessThan } from 'typeorm';
import { ADMIN_ACTIVITY_LOG_CONFIG } from '../constants';
import { AdminActivityLog } from '../entities/admin-activity-log.entity';

const LOGGER_CTX = 'AdminActivityLog';

const { RETENTION_DAYS, PRUNE_BATCH_SIZE } = ADMIN_ACTIVITY_LOG_CONFIG;

export interface PruneResult {
    deleted: number;
    cutoff: string;
}

/**
 * Enforces the retention window on the activity log.
 *
 * Deletes in bounded batches rather than one statement. A single
 * `DELETE ... WHERE createdAt < cutoff` over months of rows holds locks long
 * enough to stall the admin API on a shared server, which is exactly the class
 * of problem this plugin exists to investigate rather than cause.
 */
@Injectable()
export class ActivityLogPruneService {
    constructor(private readonly connection: TransactionalConnection) {}

    /** Deletes rows older than the retention window, in batches. */
    async prune(): Promise<PruneResult> {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
        const repository = this.connection.rawConnection.getRepository(AdminActivityLog);
        let deleted = 0;
        for (;;) {
            const batch = await repository.find({
                select: ['id'],
                where: { createdAt: LessThan(cutoff) },
                take: PRUNE_BATCH_SIZE,
            });
            if (batch.length === 0) {
                break;
            }
            await repository.delete({ id: In(batch.map(row => row.id)) });
            deleted += batch.length;
        }
        if (deleted > 0) {
            Logger.info(`Pruned ${deleted} audit rows older than ${cutoff.toISOString()}`, LOGGER_CTX);
        }
        return { deleted, cutoff: cutoff.toISOString() };
    }
}
