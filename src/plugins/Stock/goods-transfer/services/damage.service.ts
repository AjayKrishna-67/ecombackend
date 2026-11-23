import { Injectable } from '@nestjs/common';
import {
    AdministratorService,
    Asset,
    AssetService,
    EventBus,
    ForbiddenError,
    ID,
    IllegalOperationError,
    InternalServerError,
    Logger,
    Permission,
    RequestContext,
    TransactionalConnection,
    UserInputError,
} from '@vendure/core';
import { In } from 'typeorm';

import { loggerCtx } from '../constants';
import { DamageRequest } from '../entities/damage-request.entity';
import { DamageRequestLine } from '../entities/damage-request-line.entity';
import { GoodsTransfer } from '../entities/goods-transfer.entity';
import { GoodsTransferLine } from '../entities/goods-transfer-line.entity';
import { DamageRequestApprovedEvent, DamageRequestConfirmedEvent } from '../events/goods-transfer-events';
import { DamageState, DocumentKind, TransferNotificationType, TransferState } from '../types';
import {
    CLAIMED_DAMAGE_STATES,
    DAMAGE_PHOTO_THRESHOLD_PCT,
    checkDamageCap,
    computeDamagePercent,
    isPhotoMandatory,
    validateDamageQuantity,
} from './damage.helpers';
import { DocumentSequenceService } from './document-sequence.service';
import { TransferAuditService } from './transfer-audit.service';
import { TransferNotificationService } from './transfer-notification.service';
import { TransferPdfService } from './transfer-pdf.service';
import { TransferStockService } from './transfer-stock.service';

/** One damaged product as it arrives from the API. */
export interface DamageLineInput {
    lineId: ID;
    damagedPcs?: number | null;
    damagedGrams?: number | null;
    /** Kilograms — weighed lines only. Converted to grams on the way in. */
    damagedKg?: number | null;
    /**
     * The damaged amount in the LINE's own unit — 0.25 for 250 g, 4 for 4 pieces.
     * The unit-agnostic input, and the only one a counted pool accepts.
     */
    damagedPoolQty?: number | null;
    note?: string | null;
    /** Indices into the flat `photos` upload array that belong to THIS line. */
    photoIndexes?: number[] | null;
}

export interface CreateDamageInput {
    transferId: ID;
    remarks?: string | null;
    lines: DamageLineInput[];
    /** Flat upload list; each line claims its own via photoIndexes. */
    photos: any[];
}

/**
 * Damage lifecycle: PENDING_APPROVAL -> APPROVED | REJECTED.
 *
 * A request covers MANY products from one transfer — reporting a hundred damaged
 * items is one call, not a hundred. Quantities, percentages, notes and photos are
 * all per product; the approval decision is taken on the whole request.
 *
 * Stock only ever moves on approval, and only at the destination.
 */
@Injectable()
export class DamageService {
    constructor(
        private connection: TransactionalConnection,
        private assetService: AssetService,
        private sequenceService: DocumentSequenceService,
        private pdfService: TransferPdfService,
        private stockService: TransferStockService,
        private auditService: TransferAuditService,
        private notificationService: TransferNotificationService,
        private administratorService: AdministratorService,
        private eventBus: EventBus,
    ) {}

    // ----------------------------------------------------------------- create

    /**
     * The destination records damage on an APPROVED transfer and sends it in one
     * step. No stock change here — deduction happens only on approval.
     *
     * Every line is validated before anything is written, so a single bad row
     * rejects the whole request instead of half-saving it.
     */
    async createDamageRequest(ctx: RequestContext, input: CreateDamageInput): Promise<DamageRequest> {
        if (!input.lines?.length) {
            throw new UserInputError('At least one damaged product is required');
        }

        const transfer = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .findOne({ where: { id: input.transferId as any } });
        if (!transfer) {
            throw new UserInputError(`Goods transfer ${input.transferId} not found`);
        }
        if (transfer.state !== TransferState.Received) {
            throw new IllegalOperationError(
                `Damage can only be recorded on APPROVED transfers (this one is ${transfer.state})` as any,
            );
        }
        if (String(ctx.channelId) !== String(transfer.destinationChannelId)) {
            throw new ForbiddenError();
        }

        // ---- validate every line first ----
        const seen = new Set<string>();
        const prepared: Array<{
            line: GoodsTransferLine;
            amount: number;
            percent: string;
            note: string | null;
            photos: any[];
        }> = [];

        for (const [index, raw] of input.lines.entries()) {
            const line = await this.connection
                .getRepository(ctx, GoodsTransferLine)
                .findOne({ where: { id: raw.lineId as any, transferId: transfer.id as any } });
            if (!line) {
                throw new UserInputError(`Line ${index + 1}: line ${raw.lineId} is not on transfer ${transfer.transferNumber}`);
            }
            if (seen.has(String(line.id))) {
                throw new UserInputError(
                    `Line ${index + 1}: "${line.productName}" appears twice — combine it into one row`,
                );
            }
            seen.add(String(line.id));

            const qty = validateDamageQuantity(
                line.isPooled,
                raw.damagedPcs,
                raw.damagedGrams,
                raw.damagedKg,
                raw.damagedPoolQty,
                // The LINE's unit, not the product's live one: a claim is made against
                // what was delivered, and the delivery's unit is the one printed on
                // the document the branch is holding.
                line.poolUnit,
            );
            if (!qty.ok) {
                throw new UserInputError(`Line ${index + 1} ("${line.productName}"): ${qty.error}`);
            }

            // Cumulative cap per product: pending + approved must not exceed received.
            const received = line.isPooled ? line.weightGrams ?? 0 : line.quantityPcs ?? 0;
            const alreadyClaimed = await this.sumClaimed(ctx, line.id);
            const cap = checkDamageCap(alreadyClaimed, qty.amount, received);
            if (!cap.ok) {
                throw new UserInputError(`Line ${index + 1} ("${line.productName}"): ${cap.message}`);
            }

            const percent = computeDamagePercent(qty.amount, received);
            const photos = (raw.photoIndexes ?? [])
                .map(i => input.photos?.[i])
                .filter(Boolean);

            // GT-11: evidence is required per product, judged on that product's own
            // share — a 2% loss beside a 20% one still needs no photo of its own.
            //
            // Decided by isPhotoMandatory on the raw quantities, NOT by parsing the
            // percent string above. That string is rounded for display, so a line at
            // 4.999% renders as "5.00" and a parseFloat comparison demanded a photo
            // for a loss that is genuinely under the threshold. Display rounding must
            // not decide whether evidence is mandatory.
            if (isPhotoMandatory(qty.amount, received) && photos.length === 0) {
                throw new UserInputError(
                    `Line ${index + 1} ("${line.productName}"): damage is ${percent}% ` +
                        `(>= ${DAMAGE_PHOTO_THRESHOLD_PCT}%) — at least one photo is mandatory`,
                );
            }

            prepared.push({ line, amount: qty.amount, percent, note: raw.note ?? null, photos });
        }

        // ---- write ----
        const userName = await this.userName(ctx);
        // Numbered per destination channel — the branch raising the claim (PLAN §2.4).
        const { formatted: damageNumber } = await this.sequenceService.next(
            ctx,
            DocumentKind.DamageNumber,
            transfer.destinationChannelId,
        );
        const request = await this.connection.getRepository(ctx, DamageRequest).save(
            new DamageRequest({
                transferId: transfer.id,
                damageNumber,
                state: DamageState.PendingApproval,
                remarks: input.remarks ?? null,
                createdById: ctx.activeUserId ?? null,
                createdByName: userName,
            }),
        );

        const lineRepo = this.connection.getRepository(ctx, DamageRequestLine);
        for (const p of prepared) {
            const damageLine = await lineRepo.save(
                new DamageRequestLine({
                    damageRequestId: request.id,
                    lineId: p.line.id,
                    productName: p.line.productName,
                    sku: p.line.sku,
                    isPooled: p.line.isPooled,
                    poolUnit: p.line.poolUnit,
                    damagedPcs: p.line.isPooled ? null : p.amount,
                    damagedGrams: p.line.isPooled ? p.amount : null,
                    receivedQtySnapshot: p.line.isPooled ? p.line.weightGrams ?? 0 : p.line.quantityPcs ?? 0,
                    damagePercent: p.percent,
                    note: p.note,
                }),
            );
            if (p.photos.length) {
                await this.storePhotos(ctx, damageLine.id, p.photos);
            }
        }

        await this.auditService.record(ctx, {
            transferId: transfer.id,
            damageRequestId: request.id,
            action: 'DAMAGE_CREATED',
            toState: DamageState.PendingApproval,
            data: {
                products: prepared.map(p => ({
                    product: p.line.productName,
                    amount: p.amount,
                    percent: p.percent,
                })),
            },
        });

        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: transfer.sourceChannelId,
            type: TransferNotificationType.DamageConfirmed,
            title: `Damage ${damageNumber} on ${transfer.transferNumber} — ${prepared.length} product(s) awaiting approval`,
            refType: 'damage',
            refId: request.id,
            transferNumber: transfer.transferNumber,
            userName,
        });

        const created = await this.findOneOrThrow(ctx, request.id);
        Logger.verbose(
            `damage: ${damageNumber} raised on ${transfer.transferNumber} — ` +
                prepared.map(p => `${p.line.productName} ${p.percent}%`).join(', ') +
                ` [channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        await this.eventBus.publish(new DamageRequestConfirmedEvent(ctx, created, transfer));
        return created;
    }

    // ---------------------------------------------------------------- approve

    /**
     * PENDING_APPROVAL -> APPROVED for the WHOLE request: deduct every line's stock,
     * issue the damage document, notify both branches.
     *
     * Deductions run inside this one transaction, so if any product would push the
     * destination below zero the entire approval rolls back — the branch is never
     * left half-deducted.
     */
    async approveDamageRequest(ctx: RequestContext, id: ID): Promise<DamageRequest> {
        const { locked, transfer, lines } = await this.lockPending(ctx, id, 'approve');

        const stockResults = [];
        for (const dl of lines) {
            const transferLine = await this.connection
                .getRepository(ctx, GoodsTransferLine)
                .findOne({ where: { id: dl.lineId as any } });
            if (!transferLine) {
                throw new UserInputError(`Transfer line behind "${dl.productName}" no longer exists`);
            }
            stockResults.push(
                await this.stockService.deductDamage(ctx, transfer, transferLine, dl.damagedPcs, dl.damagedGrams),
            );
        }

        const userName = await this.userName(ctx);
        const photoCounts = await this.photoCounts(ctx, lines.map(l => l.id));

        // Titled by the claim's own number, issued when it was raised. There used to
        // be a second sequence here, consumed only to name this file — a number for
        // the paper describing a claim, saying nothing the claim's number did not.
        const asset = await this.pdfService.generateAndStoreDamagePdf(ctx, {
            documentNumber: locked.damageNumber,
            date: new Date(),
            transferNumber: transfer.transferNumber,
            remarks: locked.remarks,
            requestedBy: locked.createdByName,
            approvedBy: userName,
            lines: lines.map(l => ({
                productName: l.productName,
                sku: l.sku,
                damagedPcs: l.damagedPcs,
                damagedGrams: l.damagedGrams,
                poolUnit: l.poolUnit,
                damagePercent: l.damagePercent ?? '0.00',
                note: l.note,
                photoCount: photoCounts.get(String(l.id)) ?? 0,
            })),
        });

        await this.connection.getRepository(ctx, DamageRequest).update(
            { id: id as any },
            {
                state: DamageState.Approved,
                pdfAssetId: asset.id,
                approvedAt: new Date(),
                approvedByName: userName,
            },
        );
        await this.auditService.record(ctx, {
            transferId: transfer.id,
            damageRequestId: id,
            action: 'DAMAGE_APPROVED',
            fromState: DamageState.PendingApproval,
            toState: DamageState.Approved,
            data: { stock: stockResults, damageNumber: locked.damageNumber },
        });

        for (const channelId of [transfer.sourceChannelId, transfer.destinationChannelId]) {
            await this.notificationService.notifyChannel(ctx, {
                recipientChannelId: channelId,
                type: TransferNotificationType.DamageApproved,
                title: `Damage ${locked.damageNumber} on ${transfer.transferNumber} approved — ${lines.length} product(s), stock deducted`,
                refType: 'damage',
                refId: id,
                transferNumber: transfer.transferNumber,
                userName,
            });
        }

        const approved = await this.findOneOrThrow(ctx, id);
        Logger.verbose(
            `damage: ${locked.damageNumber} on ${transfer.transferNumber} APPROVED — ` +
                stockResults.map(s => `${s.productName} ${s.oldValue}->${s.newValue}`).join(', ') +
                ` [channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        await this.eventBus.publish(new DamageRequestApprovedEvent(ctx, approved, transfer));
        return approved;
    }

    // ----------------------------------------------------------------- reject

    /** PENDING_APPROVAL -> REJECTED. No stock change, no reason stored. */
    async rejectDamageRequest(ctx: RequestContext, id: ID): Promise<DamageRequest> {
        const { locked, transfer, lines } = await this.lockPending(ctx, id, 'reject');

        const userName = await this.userName(ctx);
        await this.connection
            .getRepository(ctx, DamageRequest)
            .update({ id: id as any }, { state: DamageState.Rejected });
        await this.auditService.record(ctx, {
            transferId: transfer.id,
            damageRequestId: id,
            action: 'DAMAGE_REJECTED',
            fromState: DamageState.PendingApproval,
            toState: DamageState.Rejected,
        });
        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: transfer.destinationChannelId,
            type: TransferNotificationType.DamageRejected,
            title: `Damage ${locked.damageNumber} on ${transfer.transferNumber} was rejected — ${lines.length} product(s), no stock change`,
            refType: 'damage',
            refId: id,
            transferNumber: transfer.transferNumber,
            userName,
        });
        Logger.verbose(
            `damage: ${locked.damageNumber} on ${transfer.transferNumber} REJECTED — ` +
                `${lines.length} product(s), no stock change ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return this.findOneOrThrow(ctx, id);
    }

    // ------------------------------------------------------------------ reads

    async getDamageRequests(ctx: RequestContext, transferId: ID): Promise<DamageRequest[]> {
        const transfer = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .findOne({ where: { id: transferId as any } });
        if (!transfer) {
            throw new UserInputError(`Goods transfer ${transferId} not found`);
        }
        const cid = String(ctx.channelId);
        const isSuperAdmin = ctx.userHasPermissions([Permission.SuperAdmin]);
        if (!isSuperAdmin && cid !== String(transfer.sourceChannelId) && cid !== String(transfer.destinationChannelId)) {
            throw new ForbiddenError();
        }
        return this.connection.getRepository(ctx, DamageRequest).find({
            where: { transferId: transferId as any },
            relations: ['lines', 'lines.photos'],
            order: { createdAt: 'DESC' },
        });
    }

    async findOneOrThrow(ctx: RequestContext, id: ID): Promise<DamageRequest> {
        const request = await this.connection
            .getRepository(ctx, DamageRequest)
            .findOne({ where: { id: id as any }, relations: ['lines', 'lines.photos'] });
        if (!request) {
            throw new UserInputError(`Damage request ${id} not found`);
        }
        return request;
    }

    // --------------------------------------------------------------- privates

    /** Row-lock the request, assert it is still pending, and load its lines. */
    private async lockPending(
        ctx: RequestContext,
        id: ID,
        action: string,
    ): Promise<{ locked: DamageRequest; transfer: GoodsTransfer; lines: DamageRequestLine[] }> {
        const locked = await this.connection
            .getRepository(ctx, DamageRequest)
            .createQueryBuilder('d')
            .setLock('pessimistic_write')
            .where('d.id = :id', { id })
            .getOne();
        if (!locked) {
            throw new UserInputError(`Damage request ${id} not found`);
        }
        if (locked.state !== DamageState.PendingApproval) {
            throw new IllegalOperationError(`Cannot ${action}: damage request is ${locked.state}` as any);
        }
        const transfer = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .findOne({ where: { id: locked.transferId as any } });
        if (!transfer) {
            throw new UserInputError(`Goods transfer ${locked.transferId} not found`);
        }
        // The branch that sent the goods is the branch that decides the claim (SPEC §7).
        // Without this, holding ApproveTransferDamage on ANY channel would be enough to
        // decide a claim between two OTHER branches — deducting stock at a branch the
        // caller has nothing to do with. The @Allow decorator only proves the permission
        // is held on the caller's own channel, never that it relates to this transfer.
        if (String(ctx.channelId) !== String(transfer.sourceChannelId)) {
            throw new ForbiddenError();
        }
        const lines = await this.connection
            .getRepository(ctx, DamageRequestLine)
            .find({ where: { damageRequestId: id as any } });
        if (!lines.length) {
            throw new UserInputError(`Damage request ${id} has no products`);
        }
        return { locked, transfer, lines };
    }

    /** Damaged qty already claimed (pending + approved) against one transfer line. */
    private async sumClaimed(ctx: RequestContext, lineId: ID): Promise<number> {
        const rows = await this.connection
            .getRepository(ctx, DamageRequestLine)
            .createQueryBuilder('dl')
            .innerJoin(DamageRequest, 'd', 'd.id = dl.damageRequestId')
            .where('dl.lineId = :lineId', { lineId })
            .andWhere('d.state IN (:...states)', { states: CLAIMED_DAMAGE_STATES })
            .getMany();
        return rows.reduce((sum, r) => sum + (r.damagedGrams ?? r.damagedPcs ?? 0), 0);
    }

    private async photoCounts(ctx: RequestContext, lineIds: ID[]): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (!lineIds.length) return counts;
        const lines = await this.connection.getRepository(ctx, DamageRequestLine).find({
            where: { id: In(lineIds as any[]) as any },
            relations: ['photos'],
        });
        for (const line of lines) {
            counts.set(String(line.id), (line.photos ?? []).length);
        }
        return counts;
    }

    /**
     * Upload each file as a core Asset and attach it to the line.
     *
     * Attached as a relation rather than copied into a table of our own: the Asset is
     * the photo, and a second row holding its id and a stale copy of its filename was
     * only ever a join table written by hand.
     */
    private async storePhotos(ctx: RequestContext, damageRequestLineId: ID, photos: any[]): Promise<void> {
        const stored: Asset[] = [];
        for (const file of photos) {
            const result = await this.assetService.create(ctx, { file });
            if (!(result instanceof Asset)) {
                throw new InternalServerError(
                    `Could not store damage photo: ${(result as any)?.message ?? 'invalid file'}`,
                );
            }
            stored.push(result);
        }
        if (!stored.length) {
            return;
        }
        const repo = this.connection.getRepository(ctx, DamageRequestLine);
        const line = await repo.findOne({
            where: { id: damageRequestLineId as any },
            relations: ['photos'],
        });
        if (!line) {
            throw new InternalServerError(`Damage line ${damageRequestLineId} vanished while storing photos`);
        }
        line.photos = [...(line.photos ?? []), ...stored];
        await repo.save(line);
    }

    private async userName(ctx: RequestContext): Promise<string> {
        const userId = ctx.activeUserId;
        if (!userId) return '<unknown>';
        const admin = await this.administratorService.findOneByUserId(ctx, userId);
        return admin ? `${admin.firstName} ${admin.lastName}`.trim() : '<unknown>';
    }
}
