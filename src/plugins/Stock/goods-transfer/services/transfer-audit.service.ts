import { Injectable } from '@nestjs/common';
import { AdministratorService, ID, RequestContext, TransactionalConnection } from '@vendure/core';

import { TransferAuditLog } from '../entities/transfer-audit-log.entity';

/**
 * Append-only audit trail (TDS §20 — StockChangeLog blueprint).
 *
 * Rule: rows are written in the SAME transaction as the action they record —
 * "an unauditable action must not commit". Rows are never updated or deleted.
 * Actor name is SNAPSHOTTED (survives admin renames/deletions).
 */
@Injectable()
export class TransferAuditService {
    constructor(
        private connection: TransactionalConnection,
        private administratorService: AdministratorService,
    ) {}

    async record(
        ctx: RequestContext,
        row: {
            transferId: ID;
            damageRequestId?: ID | null;
            action: string;
            fromState?: string | null;
            toState?: string | null;
            data?: Record<string, unknown> | null;
        },
    ): Promise<TransferAuditLog> {
        const actor = await this.resolveActor(ctx);
        const entry = new TransferAuditLog({
            transferId: row.transferId,
            damageRequestId: row.damageRequestId ?? null,
            action: row.action,
            fromState: row.fromState ?? null,
            toState: row.toState ?? null,
            actorId: actor.actorId,
            userName: actor.userName,
        });
        entry.data = row.data ?? null; // assigned separately — JSON column vs DeepPartial typing
        return this.connection.getRepository(ctx, TransferAuditLog).save(entry);
    }

    async getForTransfer(
        ctx: RequestContext,
        transferId: ID,
        options?: { skip?: number; take?: number },
    ): Promise<{ items: TransferAuditLog[]; totalItems: number }> {
        const take = Math.min(options?.take ?? 25, 100); // history-cap house pattern
        const [items, totalItems] = await this.connection
            .getRepository(ctx, TransferAuditLog)
            .findAndCount({
                where: { transferId: transferId as any },
                order: { createdAt: 'DESC' },
                skip: options?.skip ?? 0,
                take,
            });
        return { items, totalItems };
    }

    /** Actor snapshot with `<unknown>` fallback — location-stock resolveAdmin pattern. */
    private async resolveActor(ctx: RequestContext): Promise<{ actorId: ID | null; userName: string }> {
        const userId = ctx.activeUserId;
        if (!userId) {
            return { actorId: null, userName: '<unknown>' };
        }
        const admin = await this.administratorService.findOneByUserId(ctx, userId);
        if (!admin) {
            return { actorId: null, userName: '<unknown>' };
        }
        return { actorId: admin.id, userName: `${admin.firstName} ${admin.lastName}`.trim() };
    }
}
