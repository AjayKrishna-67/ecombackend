import { Injectable } from '@nestjs/common';
import {
    AdministratorService,
    Asset,
    Channel,
    EventBus,
    ForbiddenError,
    ID,
    IllegalOperationError,
    Logger,
    Permission,
    Product,
    ProductVariant,
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
import { CLAIMED_DAMAGE_STATES } from './damage.helpers';
import {
    GoodsTransferConfirmedEvent,
    GoodsTransferDispatchedEvent,
    GoodsTransferReceivedEvent,
} from '../events/goods-transfer-events';
import { DocumentKind, TransferNotificationType, TransferState } from '../types';
import { DocumentSequenceService } from './document-sequence.service';
import {
    diffTransferLines,
    isEmptyDiff,
    normalizeLineInput,
    resolvePoolBase,
    summariseDiff,
    transferStateError,
    RawLineInput,
} from './goods-transfer.helpers';
import {
    DEFAULT_POOL_UNIT,
    fillPoolUnits,
    poolUnitSuffix,
    poolUnitsForProducts,
} from './pool-unit.helper';
import { TransferAuditService } from './transfer-audit.service';
import { TransferChannelService } from './transfer-channel.service';
import { TransferNotificationService } from './transfer-notification.service';
import { TransferPdfService } from './transfer-pdf.service';
import { TransferStockService } from './transfer-stock.service';

/**
 * Which consignments a printed sheet should cover.
 *
 * `direction` says which side of them this branch is on: OUT for what it is sending,
 * IN for what is coming to it — its own requests included. `branchIds` then names the
 * branches at the far end. `transferIds` names transfers outright and silences the
 * other filters; the direction still applies, so an id of someone else's transfer
 * finds nothing.
 */
export interface ConsignmentSelection {
    direction?: 'OUT' | 'IN' | null;
    branchIds?: ID[] | null;
    from?: string | null;
    to?: string | null;
    transferIds?: ID[] | null;
}

export interface GoodsTransferListOptions {
    skip?: number;
    take?: number;
    state?: TransferState;
    /** 'outbound' = I am source; 'inbound' = I am destination; omit = both. */
    direction?: 'outbound' | 'inbound';
    /** Matches the transfer number — the only identifier users search by. */
    search?: string;
}

/**
 * Goods Transfer aggregate service — the whole lifecycle:
 * create / update / delete the entry, then confirm -> dispatch -> receive.
 *
 * Strictly forward, no reversal: correcting a load is an edit in place, so a
 * transfer never moves backwards and its number is never reissued (SPEC §2/§4).
 *
 * Channel rules: every read is scoped to ctx.channelId (source OR destination side);
 * every write asserts the acting side. Receiving is destination-only and is the ONLY
 * action in the module that writes stock.
 */
@Injectable()
export class GoodsTransferService {
    constructor(
        private connection: TransactionalConnection,
        private channelService: TransferChannelService,
        private sequenceService: DocumentSequenceService,
        private auditService: TransferAuditService,
        private administratorService: AdministratorService,
        private pdfService: TransferPdfService,
        private notificationService: TransferNotificationService,
        private stockService: TransferStockService,
        private eventBus: EventBus,
    ) {}

    // ---------------------------------------------------------------- create

    /**
     * Start a new transfer. Source-side. Products are validated against the
     * DESTINATION channel — you transfer what the receiving branch stocks.
     */
    async create(
        ctx: RequestContext,
        input: {
            destinationChannelId: ID;
            remarks?: string | null;
            driverName?: string | null;
            driverPhone?: string | null;
            vehicleNumber?: string | null;
            lines: RawLineInput[];
        },
    ): Promise<GoodsTransfer> {
        if (!input.lines?.length) {
            throw new UserInputError('At least one line is required');
        }
        // Destination: any branch except the one being worked in — re-checked server-side.
        const destination = await this.channelService.validateDestination(ctx, input.destinationChannelId);
        const sourceChannelId = ctx.channelId;

        const { formatted } = await this.sequenceService.next(ctx, DocumentKind.TransferNumber, sourceChannelId);
        const userName = await this.userName(ctx);

        const channels = await this.connection
            .getRepository(ctx, Channel)
            .find({ where: { id: In([sourceChannelId, destination.id]) as any } });

        const transfer = await this.connection.getRepository(ctx, GoodsTransfer).save(
            new GoodsTransfer({
                transferNumber: formatted,
                state: TransferState.Draft,
                sourceChannelId,
                destinationChannelId: destination.id,
                remarks: input.remarks ?? null,
                driverName: input.driverName ?? null,
                driverPhone: input.driverPhone ?? null,
                vehicleNumber: input.vehicleNumber ?? null,
                createdById: ctx.activeUserId ?? null,
                createdByName: userName,
                channels, // both sides see it in their channel-scoped lists (BR-03)
            }),
        );

        const products = await this.applyLineChanges(ctx, transfer.id, destination.id, input.lines);

        await this.auditService.record(ctx, {
            transferId: transfer.id,
            action: 'CREATED',
            toState: TransferState.Draft,
            data: { destinationChannel: destination.code, products },
        });
        Logger.verbose(
            `create: transfer ${transfer.id} (${formatted}) -> ${destination.code}, ` +
                `${input.lines.length} line(s): ${products.join(', ')} ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return this.findOneOrThrow(ctx, transfer.id);
    }

    // --------------------------------------------------------------- request

    /**
     * Ask another branch to send these items. Raised by the RECEIVING branch, which is
     * the whole difference from `create`: here the caller is the destination and the
     * chosen channel is the source.
     *
     * The row it writes is an ordinary GoodsTransfer, deliberately. A request that
     * carried its own entity would need its own edit, its own confirm, its own document
     * and its own receipt — four copies of a pipeline that already exists, kept in step
     * by hand. Instead the request IS the transfer, sitting one state earlier: the
     * source edits it, confirms it and dispatches it exactly as it would its own load,
     * and the goods arrive through the same receipt that writes stock.
     *
     * The number comes from the SOURCE branch's sequence, because the source is the
     * branch that will ship it and the per-source uniqueness index is what the number
     * is scoped by. Nothing here reserves stock: a request is a question, and stock
     * moves only when the goods are received.
     */
    async createRequest(
        ctx: RequestContext,
        input: {
            sourceChannelId: ID;
            remarks?: string | null;
            lines: RawLineInput[];
            /** false keeps it private until sendRequest; the default sends immediately. */
            send?: boolean | null;
        },
    ): Promise<GoodsTransfer> {
        if (!input.lines?.length) {
            throw new UserInputError('At least one line is required');
        }
        const source = await this.channelService.validateRequestSource(ctx, input.sourceChannelId);
        const destinationChannelId = ctx.channelId;

        const { formatted } = await this.sequenceService.next(ctx, DocumentKind.TransferNumber, source.id);
        const userName = await this.userName(ctx);

        const channels = await this.connection
            .getRepository(ctx, Channel)
            .find({ where: { id: In([source.id, destinationChannelId]) as any } });

        // Sending is the default. A draft is the deliberate case — the branch wants to
        // print the sheet and walk the shelves before anyone else is told.
        const sendNow = input.send !== false;

        const transfer = await this.connection.getRepository(ctx, GoodsTransfer).save(
            new GoodsTransfer({
                transferNumber: formatted,
                state: sendNow ? TransferState.Requested : TransferState.RequestDraft,
                sourceChannelId: source.id,
                destinationChannelId,
                remarks: input.remarks ?? null,
                // `createdBy` is the branch that raised the row whatever its state, so it
                // is filled here too. `requestedAt` is what survives the move to DRAFT.
                requestedAt: new Date(),
                requestedByName: userName,
                createdById: ctx.activeUserId ?? null,
                createdByName: userName,
                channels,
            }),
        );

        // Lines are checked against the DESTINATION channel, the same rule `create`
        // applies — and here the destination is the branch doing the asking. A branch
        // cannot request what it could not sell once it arrived.
        const products = await this.applyLineChanges(ctx, transfer.id, destinationChannelId, input.lines);

        await this.auditService.record(ctx, {
            transferId: transfer.id,
            action: sendNow ? 'REQUESTED' : 'REQUEST_DRAFTED',
            toState: sendNow ? TransferState.Requested : TransferState.RequestDraft,
            data: { sourceChannel: source.code, products },
        });

        // Only once it is actually sent. Telling the other branch about a draft would
        // make it a request, which is the one thing a draft is not.
        if (sendNow) {
            await this.announceRequest(ctx, transfer, source.id, input.lines.length, userName);
        }
        Logger.verbose(
            `createRequest: transfer ${transfer.id} (${formatted}) <- ${source.code}, ` +
                `${input.lines.length} line(s): ${products.join(', ')} ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return this.findOneOrThrow(ctx, transfer.id);
    }

    /** Tell the branch being asked. A request nobody sees is a request nobody fills. */
    private async announceRequest(
        ctx: RequestContext,
        transfer: GoodsTransfer,
        sourceChannelId: ID,
        lineCount: number,
        userName: string,
    ): Promise<void> {
        const destinationCode = await this.getChannelCode(ctx, transfer.destinationChannelId);
        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: sourceChannelId,
            type: TransferNotificationType.TransferRequested,
            title: `${destinationCode} has requested ${lineCount} item(s) — ${transfer.transferNumber}`,
            refType: 'transfer',
            refId: transfer.id,
            transferNumber: transfer.transferNumber,
            userName,
        });
    }

    /**
     * Correct a request that has not been sent yet.
     *
     * The same edit as `update`, reachable by the branch that WROTE the request rather
     * than by whoever may edit transfers. Those are different people: a Receiving
     * Manager raises requests and holds no Update permission at all, and gating the
     * correction on Update left them able to write a draft and unable to fix it —
     * which is a draft that cannot do the one thing drafts are for.
     *
     * Refuses anything but REQUEST_DRAFT, so widening the permission cannot reach a
     * transfer that is already moving.
     */
    async updateRequestDraft(
        ctx: RequestContext,
        input: Parameters<GoodsTransferService['update']>[1],
    ): Promise<GoodsTransfer> {
        const transfer = await this.findOneOrThrow(ctx, input.id);
        this.assertState(transfer, [TransferState.RequestDraft], 'edit request');
        return this.update(ctx, input);
    }

    /**
     * Send a request that has been sitting as a draft.
     *
     * The one moment a request becomes visible to the branch being asked. Destination-
     * only, because it is that branch's own row until this call — and REQUEST_DRAFT is
     * the only state it accepts, so a request already sent cannot be sent twice and
     * arrive as two.
     */
    async sendRequest(ctx: RequestContext, id: ID): Promise<GoodsTransfer> {
        const transfer = await this.lockTransfer(ctx, id);
        this.channelService.assertDestinationChannel(ctx, transfer);
        this.assertState(transfer, [TransferState.RequestDraft], 'send request');

        const lines = await this.connection
            .getRepository(ctx, GoodsTransferLine)
            .find({ where: { transferId: id as any } });
        if (lines.length === 0) {
            throw new UserInputError('Cannot send: the request has no lines');
        }

        const userName = await this.userName(ctx);
        await this.connection
            .getRepository(ctx, GoodsTransfer)
            .update({ id: transfer.id as any }, { state: TransferState.Requested });

        await this.auditService.record(ctx, {
            transferId: transfer.id,
            action: 'REQUESTED',
            fromState: TransferState.RequestDraft,
            toState: TransferState.Requested,
        });
        await this.announceRequest(ctx, transfer, transfer.sourceChannelId, lines.length, userName);

        Logger.verbose(
            `sendRequest: transfer ${transfer.id} (${transfer.transferNumber}) sent ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return this.findOneOrThrow(ctx, transfer.id);
    }

    // ---------------------------------------------------------------- update

    /**
     * Edit a transfer — allowed at DRAFT, CONFIRMED and DISPATCHED (SPEC §4).
     *
     * Real cases this exists for: the destination asks for extra items while the
     * vehicle is still nearby (stop it, add lines), or an item is found missing after
     * the vehicle has gone (drop that line). Both are edits, not reversals — the
     * transfer never goes backwards and the number never changes.
     *
     * Once the destination has been told about the transfer (CONFIRMED onward) an edit
     * is not silent: the line set is diffed, the diff is recorded on the audit entry,
     * the document is regenerated so the driver's copy matches, and the destination is
     * notified of exactly what changed.
     *
     * RECEIVED is closed — stock is already written, so a change there is a stock
     * correction (the damage flow), not a transfer edit.
     */
    async update(
        ctx: RequestContext,
        input: {
            id: ID;
            remarks?: string | null;
            driverName?: string | null;
            driverPhone?: string | null;
            vehicleNumber?: string | null;
            lines?: RawLineInput[] | null;
            removeLineIds?: ID[] | null;
        },
    ): Promise<GoodsTransfer> {
        // Lock BEFORE checking the state. Reading it unlocked is a time-of-check to
        // time-of-use hole: a concurrent receive() can post stock and move the transfer
        // to RECEIVED while this edit is still working from its snapshot, and the edit
        // would then rewrite the lines of a transfer whose stock is already committed.
        const transfer = await this.lockTransfer(ctx, input.id);
        // A request draft is the destination's own row and nobody else's — it is the
        // branch that wrote it that corrects it after walking the shelves. Every other
        // state belongs to the source, which is the branch holding the goods.
        if (transfer.state === TransferState.RequestDraft) {
            this.channelService.assertDestinationChannel(ctx, transfer);
        } else {
            this.channelService.assertSourceChannel(ctx, transfer);
        }
        this.assertState(
            transfer,
            [
                TransferState.RequestDraft,
                TransferState.Requested,
                TransferState.Draft,
                TransferState.Confirmed,
                TransferState.Dispatched,
            ],
            'edit',
        );
        // REQUESTED is the destination's ask. The source saving it IS the acceptance —
        // it becomes an ordinary draft here, and from this point the request is
        // indistinguishable from a load the source started itself (`requestedAt` is what
        // still remembers). No separate accept call: saving what you intend to send says
        // the same thing, and a state that could only ever be advanced by the next click
        // is a step to forget, not a decision to record.
        const wasRequest = transfer.state === TransferState.Requested;
        // A request draft stays a draft when it is edited. Editing it is the branch
        // correcting its own list, not accepting anything, and moving it forward here
        // would send it the moment someone fixed a quantity.
        const isDraftedRequest = transfer.state === TransferState.RequestDraft;
        const isPublished =
            !wasRequest && !isDraftedRequest && transfer.state !== TransferState.Draft;

        const patch: Partial<GoodsTransfer> = {};
        if (wasRequest) patch.state = TransferState.Draft;
        if (input.remarks !== undefined) patch.remarks = input.remarks;
        if (input.driverName !== undefined) patch.driverName = input.driverName;
        if (input.driverPhone !== undefined) patch.driverPhone = input.driverPhone;
        if (input.vehicleNumber !== undefined) patch.vehicleNumber = input.vehicleNumber;
        if (Object.keys(patch).length) {
            await this.connection.getRepository(ctx, GoodsTransfer).update({ id: transfer.id as any }, patch);
        }

        const removes = input.removeLineIds ?? [];
        const changes = input.lines ?? [];

        if (removes.length || changes.length) {
            const lineRepo = this.connection.getRepository(ctx, GoodsTransferLine);
            // Snapshot BEFORE anything is written — this is what the destination was
            // last told about, and it is gone the moment the first row changes.
            const before = await lineRepo.find({ where: { transferId: transfer.id as any } });

            // Removals first. A row can then be dropped and its product re-added in the
            // same call; the other order would trip the duplicate guard on the way in.
            const removed = removes.length
                ? await this.removeLines(ctx, transfer.id, removes)
                : [];
            const products = changes.length
                ? await this.applyLineChanges(ctx, transfer.id, transfer.destinationChannelId, changes)
                : [];

            if (!isPublished) {
                await this.auditService.record(ctx, {
                    transferId: transfer.id,
                    action: 'DRAFT_SAVED',
                    data: { ...(products.length ? { products } : {}), ...(removed.length ? { removed } : {}) },
                });
            } else {
                const after = await lineRepo.find({ where: { transferId: transfer.id as any } });
                await this.recordPublishedEdit(ctx, transfer, before, after);
            }
        }
        return this.findOneOrThrow(ctx, input.id);
    }

    /**
     * The CONFIRMED/DISPATCHED half of an edit: diff, regenerate the document, notify.
     *
     * A no-op edit — same products, same quantities — is not announced. Re-saving an
     * unchanged screen must not tell the destination to re-check a load that did not
     * move. The document is still rewritten either way, so it can never drift from
     * the data.
     */
    private async recordPublishedEdit(
        ctx: RequestContext,
        transfer: GoodsTransfer,
        before: GoodsTransferLine[],
        after: GoodsTransferLine[],
    ): Promise<void> {
        const diff = diffTransferLines(before, after);
        const userName = await this.userName(ctx);

        // Regenerate first: the driver's paper must match the data even when the edit
        // changed nothing worth announcing.
        const asset = await this.generateDocument(ctx, transfer, after, userName);
        if (String(asset.id) !== String(transfer.pdfAssetId)) {
            await this.connection
                .getRepository(ctx, GoodsTransfer)
                .update({ id: transfer.id as any }, { pdfAssetId: asset.id });
        }

        await this.auditService.record(ctx, {
            transferId: transfer.id,
            action: 'EDITED',
            fromState: transfer.state,
            toState: transfer.state,
            data: { ...diff },
        });

        if (isEmptyDiff(diff)) {
            return;
        }
        const summary = summariseDiff(diff);
        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: transfer.destinationChannelId,
            type: TransferNotificationType.TransferUpdated,
            title: `Transfer ${transfer.transferNumber} revised — ${summary}`,
            refType: 'transfer',
            refId: transfer.id,
            transferNumber: transfer.transferNumber,
            userName,
        });
        Logger.verbose(
            `update: transfer ${transfer.id} (${transfer.transferNumber}) edited at ${transfer.state} ` +
                `[${summary}, channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
    }

    /**
     * Build and store the transfer document. Passing the transfer's current
     * pdfAssetId makes this REPLACE the existing file rather than issue another, so
     * one transfer keeps one document for its whole life and no superseded copies
     * accumulate (SPEC §5).
     */
    private async generateDocument(
        ctx: RequestContext,
        transfer: GoodsTransfer,
        lines: GoodsTransferLine[],
        userName: string,
    ): Promise<Asset> {
        const channels = await this.connection.getRepository(ctx, Channel).find({
            where: { id: In([transfer.sourceChannelId, transfer.destinationChannelId]) as any },
        });
        const codeOf = (channelId: ID, fallback: string) =>
            channels.find(c => String(c.id) === String(channelId))?.code ?? fallback;

        // The unit is printed beside every quantity, so a line with no snapshot has
        // it filled in from the product rather than defaulting to kilograms on paper
        // a driver is about to load from.
        await this.fillPoolUnits(ctx, lines);

        return this.pdfService.generateAndStoreTransferPdf(
            ctx,
            {
                transferNumber: transfer.transferNumber,
                // The document is titled by the transfer it documents. A separate
                // number for the paper said nothing the transfer number did not.
                documentNumber: transfer.transferNumber,
                date: new Date(),
                sourceChannelCode: codeOf(transfer.sourceChannelId, 'source'),
                destinationChannelCode: codeOf(transfer.destinationChannelId, 'destination'),
                preparedBy: transfer.createdByName || userName,
                remarks: transfer.remarks,
                driverName: transfer.driverName,
                driverPhone: transfer.driverPhone,
                vehicleNumber: transfer.vehicleNumber,
                lines: lines.map(l => ({
                    productName: l.productName,
                    sku: l.sku,
                    quantityPcs: l.quantityPcs,
                    weightGrams: l.weightGrams,
                    poolUnit: l.poolUnit,
                })),
            },
            transfer.pdfAssetId,
        );
    }


    /**
     * Apply the line changes the caller sent. Nothing else on the transfer is touched.
     *
     * A row carrying an `id` has its QUANTITY updated. A row without one is added. A
     * row the caller did not mention stays exactly as it was.
     *
     * That last rule is the whole point. This used to treat `lines` as the complete
     * set and delete whatever was missing, so editing one quantity meant resending all
     * ten rows — and sending nine deleted the tenth without a word. An edit must change
     * what it names and nothing else. Removing is its own explicit instruction
     * (removeLineIds), because deleting a branch's paperwork should never be something
     * that happens because a field was left out.
     *
     * The product on an existing row is fixed for life: id and product together are
     * rejected rather than obeyed. A damage claim references a line id, and letting
     * that row become a different product would leave the claim naming goods nobody
     * ever sent. Changing the product is remove-then-add, which says what it means.
     *
     * Every added product is validated against the DESTINATION channel, so one pulled
     * from that branch since the draft was written is refused now rather than at
     * confirm. Returns the names touched, for the audit entry.
     */
    private async applyLineChanges(
        ctx: RequestContext,
        transferId: ID,
        destinationChannelId: ID,
        rawLines: RawLineInput[],
    ): Promise<string[]> {
        const lineRepo = this.connection.getRepository(ctx, GoodsTransferLine);
        const existing = await lineRepo.find({ where: { transferId: transferId as any } });
        const keyOf = (isPooled: boolean, productId: ID, variantId: ID | null) =>
            isPooled ? `p:${productId}` : `v:${variantId ?? ''}`;
        const existingById = new Map(existing.map(l => [String(l.id), l]));
        // Products already on the transfer, so a second row for one is caught before
        // it reaches the database and its unique-per-product rule.
        const takenKeys = new Set(
            existing.map(l => keyOf(l.isPooled, l.productId, l.productVariantId)),
        );

        const touched: string[] = [];

        for (const [index, raw] of rawLines.entries()) {
            const label = `Line ${index + 1}`;

            // ---- existing row: quantity only ----
            if (raw.id != null) {
                const line = existingById.get(String(raw.id));
                if (!line) {
                    throw new UserInputError(
                        `${label}: line ${raw.id} is not on this transfer. ` +
                            'Reload the screen — it is showing a line that has since been removed.',
                    );
                }
                if (raw.productId != null || raw.productVariantId != null) {
                    throw new UserInputError(
                        `${label}: cannot change the product on "${line.productName}". ` +
                            'Remove the line and add the new product instead.',
                    );
                }
                const quantity = await this.resolveQuantityForLine(ctx, line, raw, label);
                await lineRepo.update({ id: line.id as any }, quantity);
                touched.push(line.productName);
                continue;
            }

            // ---- new row ----
            const { product, variant } = await this.loadProductForLine(ctx, raw, index, destinationChannelId);
            const isPooled = this.isPooledProduct(product);
            // Only a pool has a unit to resolve, and resolving one costs a query per
            // line — a PCS line is counted in pieces by definition.
            const poolUnit = isPooled ? await this.poolUnitForProduct(ctx, product.id) : null;
            const result = normalizeLineInput(raw, { id: product.id, isPooled, poolUnit });
            if (!result.ok) {
                throw new UserInputError(`${label}: ${result.error}`);
            }

            const productName = this.translatedName(ctx, product);
            const resolvedName = isPooled ? productName : variant ? variant.name || productName : productName;
            const key = keyOf(isPooled, product.id, result.value.productVariantId as ID | null);
            if (takenKeys.has(key)) {
                throw new UserInputError(
                    `${label}: "${resolvedName}" is already on this transfer — ` +
                        'change that line instead of adding a second one',
                );
            }
            takenKeys.add(key);

            await lineRepo.save(
                new GoodsTransferLine({
                    transferId,
                    productId: product.id,
                    productVariantId: result.value.productVariantId,
                    productName: resolvedName,
                    sku: variant?.sku ?? '',
                    isPooled,
                    poolUnit: result.value.poolUnit,
                    quantityPcs: result.value.quantityPcs,
                    weightGrams: result.value.weightGrams,
                }),
            );
            touched.push(resolvedName);
        }

        return touched;
    }

    /**
     * The new quantity for an existing line, in the unit that line already uses.
     *
     * The line's own snapshots decide which unit is accepted — not the caller.
     * Sending pieces for a pool line is a mistake worth naming, not something to
     * interpret.
     *
     * The pool unit comes from the LINE, falling back to the product only for rows
     * written before the unit was recorded. Re-deriving it from the product on every
     * edit would let an option group edited mid-transfer change what an existing
     * number means, which is the whole reason it is snapshotted.
     */
    private async resolveQuantityForLine(
        ctx: RequestContext,
        line: GoodsTransferLine,
        raw: RawLineInput,
        label: string,
    ): Promise<{ quantityPcs: number | null; weightGrams: number | null }> {
        if (line.isPooled) {
            const poolUnit = line.poolUnit ?? (await this.poolUnitForProduct(ctx, line.productId));
            const suffix = poolUnitSuffix(poolUnit);
            if (raw.quantityPcs != null) {
                throw new UserInputError(
                    `${label} ("${line.productName}"): this is a pool product measured in ${suffix} — ` +
                        'send poolQty, not quantityPcs',
                );
            }
            const pool = resolvePoolBase(raw, poolUnit);
            if (!pool.ok) {
                throw new UserInputError(`${label} ("${line.productName}"): ${pool.error}`);
            }
            if (pool.base === null) {
                throw new UserInputError(
                    `${label} ("${line.productName}"): send a positive poolQty, in ${suffix}`,
                );
            }
            return { quantityPcs: null, weightGrams: pool.base };
        }

        if (raw.weightKg != null || raw.weightGrams != null || raw.poolQty != null) {
            throw new UserInputError(
                `${label} ("${line.productName}"): this is a piece-counted product — send quantityPcs, not a pool quantity`,
            );
        }
        if (!Number.isInteger(raw.quantityPcs) || (raw.quantityPcs as number) <= 0) {
            throw new UserInputError(
                `${label} ("${line.productName}"): quantityPcs must be a whole number greater than zero`,
            );
        }
        return { quantityPcs: raw.quantityPcs as number, weightGrams: null };
    }

    /**
     * What one product's pool is counted in, read from the same measurements the
     * stock maths uses. See pool-unit.helper.ts for why the pool flag alone is not
     * enough to answer this.
     *
     * Public because the API resolver needs it too: a line saved before the unit was
     * recorded carries no snapshot, and the honest answer for one of those is
     * whatever the product says today.
     */
    async poolUnitForProduct(ctx: RequestContext, productId: ID): Promise<string> {
        const units = await this.poolUnitsForProducts(ctx, [productId]);
        return units.get(String(productId)) ?? DEFAULT_POOL_UNIT;
    }

    /** See pool-unit.helper.ts — a plain function so the report service shares it. */
    poolUnitsForProducts(ctx: RequestContext, productIds: ID[]): Promise<Map<string, string>> {
        return poolUnitsForProducts(ctx, this.connection, productIds);
    }

    /** See pool-unit.helper.ts. */
    fillPoolUnits<T extends { productId: ID; isPooled: boolean; poolUnit: string | null }>(
        ctx: RequestContext,
        lines: T[],
    ): Promise<T[]> {
        return fillPoolUnits(ctx, this.connection, lines);
    }

    /**
     * Drop the named lines. The caller says which — nothing is inferred from absence.
     *
     * A transfer cannot be emptied this way: with no lines it can never be confirmed,
     * so it would sit there looking valid while holding a burned number. Delete the
     * draft instead, which says what is actually meant.
     */
    private async removeLines(ctx: RequestContext, transferId: ID, lineIds: ID[]): Promise<string[]> {
        const lineRepo = this.connection.getRepository(ctx, GoodsTransferLine);
        const existing = await lineRepo.find({ where: { transferId: transferId as any } });
        const byId = new Map(existing.map(l => [String(l.id), l]));

        const doomed: GoodsTransferLine[] = [];
        for (const lineId of lineIds) {
            const line = byId.get(String(lineId));
            if (!line) {
                throw new UserInputError(
                    `Line ${lineId} is not on this transfer. ` +
                        'Reload the screen — it is showing a line that has since been removed.',
                );
            }
            if (!doomed.some(d => String(d.id) === String(line.id))) {
                doomed.push(line);
            }
        }
        if (!doomed.length) {
            return [];
        }
        if (doomed.length >= existing.length) {
            throw new UserInputError(
                'A transfer must have at least one line — this would remove them all. ' +
                    'Delete the draft instead.',
            );
        }
        await lineRepo.delete({ id: In(doomed.map(l => l.id)) as any });
        return doomed.map(l => l.productName);
    }

    // ------------------------------------------------------- destination search

    /**
     * Products of the branch chosen in the dropdown. Re-runs the same
     * membership check the create path enforces, so the picker can never show
     * products from a branch this user is not allowed to ship to.
     *
     * YOUR OWN channel is allowed through without that check, and has to be: the
     * product-request screen lists what can arrive HERE, and the branch doing the
     * asking is the destination. `validateDestination` exists to stop a branch shipping
     * to itself, which is a rule about transfers and not about reading a catalogue —
     * applied here it refused every branch a sight of its own shelf.
     *
     * `take` is the screen saying what it is. A picker types and wants a short answer;
     * the request screen scrolls a whole catalogue and a 25-row cap silently hid the
     * other five hundred.
     */
    async searchTransferProducts(
        ctx: RequestContext,
        destinationChannelId: ID,
        search?: string | null,
        take?: number | null,
    ): Promise<Awaited<ReturnType<GoodsTransferService['findDestinationProducts']>>> {
        if (String(destinationChannelId) !== String(ctx.channelId)) {
            await this.channelService.validateDestination(ctx, destinationChannelId);
        }
        return this.findDestinationProducts(ctx, destinationChannelId, search, take);
    }

    /** How many products one search returns. The picker is typed into, not scrolled. */
    private static readonly PRODUCT_PICKER_LIMIT = 25;

    /**
     * The most a caller may ask for at once.
     *
     * The product-request screen genuinely wants the whole branch catalogue — six
     * hundred rows it scrolls and ticks — so the picker's cap cannot be the ceiling.
     * A ceiling is still needed: `take` arrives from a client, and an unbounded one is
     * an invitation to ask for the entire database in a single query.
     */
    private static readonly PRODUCT_MAX_LIMIT = 2000;

    /**
     * Products assigned to the DESTINATION channel — the only products that can be
     * transferred to it. English name + SKU for source-side lookup; isPooled tells the
     * screen whether to ask at product or variant level, and poolUnit tells it what
     * to ask for — kilograms, litres or a plain count.
     *
     * DISABLED products and variants ARE included, and `enabled` is returned so the
     * screen can label them. This picker is admin-only, and "not on sale" is not the
     * same as "does not exist": an item pulled from the app — a packing crate, a line
     * being wound down — is still something a branch physically ships. Hiding it here
     * would mean it could not be put on the paperwork at all.
     *
     * What `enabled` does decide is stock: a disabled line is documented and delivered
     * but never posted to stock. That rule lives in TransferStockService, not here.
     *
     * The search matches ANYWHERE in the product name, variant name or SKU. Prefix-only
     * was tried and was wrong for this catalogue: products are named by what they are
     * rather than by a brand-first convention, so someone reaching for "Carrot Juice"
     * types "juice" and a prefix match returns nothing.
     *
     * Capped at PRODUCT_PICKER_LIMIT. The cap is the point, not a limitation — the
     * picker is typed into, and a hundred rows is a list nobody reads.
     *
     * Deleted rows are excluded; a deleted product genuinely does not exist.
     */
    async findDestinationProducts(
        ctx: RequestContext,
        destinationChannelId: ID,
        search?: string | null,
        take?: number | null,
    ): Promise<
        Array<{
            productId: ID;
            productName: string;
            isPooled: boolean;
            poolUnit: string | null;
            enabled: boolean;
            variants: Array<{ id: ID; sku: string; name: string; enabled: boolean }>;
        }>
    > {
        const qb = this.connection
            .getRepository(ctx, Product)
            .createQueryBuilder('product')
            .innerJoin('product.channels', 'channel', 'channel.id = :cid', {
                cid: destinationChannelId,
            })
            .leftJoinAndSelect('product.translations', 'pt')
            .leftJoinAndSelect('product.variants', 'variant', 'variant.deletedAt IS NULL')
            .leftJoinAndSelect('variant.translations', 'vt')
            .where('product.deletedAt IS NULL')
            .orderBy('pt.name', 'ASC')
            .take(
                Math.min(
                    Math.max(1, take ?? GoodsTransferService.PRODUCT_PICKER_LIMIT),
                    GoodsTransferService.PRODUCT_MAX_LIMIT,
                ),
            );
        if (search && search.trim()) {
            // Matches anywhere in the name or SKU, not just the start. Half this
            // catalogue is named by what a thing IS rather than what it is called —
            // "Carrot Juice", "MilkyMist Paneer" — so someone reaching for the juice
            // types "juice", and a prefix match would find nothing.
            qb.andWhere('(pt.name LIKE :s OR variant.sku LIKE :s OR vt.name LIKE :s)', {
                s: `%${search.trim()}%`,
            });
        }
        const products = await qb.getMany();

        // Units for the whole page in a fixed number of queries, not one per product.
        // This screen asks for up to 2000 rows, and poolUnitsForProducts is built to
        // be handed the whole batch — measuring them product by product would put a
        // pair of queries behind every row of a search box somebody types into.
        //
        // The variants are re-read rather than taken off `product.variants`, and that
        // is load-bearing: the search above filters the JOINED variants too, so
        // typing "10 no" leaves a product holding only the variants that matched.
        // The pool's unit is a property of the whole product — weight wins over a
        // count across ALL its variants — so deciding it from a filtered subset would
        // let a search term change what unit a product appears to be measured in.
        const pooledIds = products.filter(p => this.isPooledProduct(p)).map(p => p.id);
        const unitByProductId = await this.poolUnitsForProducts(ctx, pooledIds);

        return products.map(p => ({
            productId: p.id,
            productName: this.translatedName(ctx, p),
            isPooled: this.isPooledProduct(p),
            // Null on a PCS product, which is counted in pieces by definition and has
            // no pool for a unit to belong to.
            poolUnit: unitByProductId.get(String(p.id)) ?? null,
            enabled: p.enabled,
            variants: (p.variants ?? []).map(v => ({
                id: v.id,
                sku: v.sku,
                name: this.translateVariant(ctx, v).name || v.sku,
                enabled: v.enabled,
            })),
        }));
    }

    /**
     * Deletes the transfer outright.
     *
     * Allowed while the goods are still the source's problem — DRAFT, CONFIRMED and
     * DISPATCHED. Refused once RECEIVED: stock has moved by then, and the row is the
     * only record of where it came from.
     *
     * The delete is permanent. That is a deliberate choice over a cancelled state
     * that lingers in every list: a load called off is not a load, and the number is
     * burned either way. The paper consequence is real and cannot be solved here —
     * a DISPATCHED transfer already has a printed document in a vehicle, so deleting
     * one is a decision to make a phone call as well.
     *
     * If the destination had already been told (anything past DRAFT), it is told
     * again — otherwise it waits for goods that are not coming.
     */
    async deleteTransfer(ctx: RequestContext, id: ID): Promise<boolean> {
        const transfer = await this.lockTransfer(ctx, id);
        // A pending request is the destination's own row, so the destination is who can
        // withdraw it. Every other state belongs to the source, which is the branch
        // holding the goods.
        if (
            transfer.state === TransferState.RequestDraft ||
            transfer.state === TransferState.Requested
        ) {
            this.channelService.assertDestinationChannel(ctx, transfer);
        } else {
            this.channelService.assertSourceChannel(ctx, transfer);
        }
        this.assertState(
            transfer,
            [
                TransferState.RequestDraft,
                TransferState.Requested,
                TransferState.Draft,
                TransferState.Confirmed,
                TransferState.Dispatched,
            ],
            'delete',
        );

        // Nobody has been told about a REQUESTED row except the branch being asked, and
        // it is the source's own list that carries it — the same as a draft. A
        // REQUEST_DRAFT nobody has seen at all.
        const wasAnnounced =
            transfer.state !== TransferState.Draft &&
            transfer.state !== TransferState.Requested &&
            transfer.state !== TransferState.RequestDraft;
        if (wasAnnounced) {
            const sourceCode = await this.getChannelCode(ctx, transfer.sourceChannelId);
            await this.notificationService.notifyChannel(ctx, {
                recipientChannelId: transfer.destinationChannelId,
                type: TransferNotificationType.TransferDeleted,
                title: `Transfer ${transfer.transferNumber} from ${sourceCode} was cancelled — it is not coming`,
                refType: 'transfer',
                refId: transfer.id,
                transferNumber: transfer.transferNumber,
                userName: await this.userName(ctx),
            });
        }

        // Written before the row goes, so the trail exists even though the delete
        // that follows removes it along with the transfer.
        await this.auditService.record(ctx, {
            transferId: transfer.id,
            action: 'DELETED',
            fromState: transfer.state,
            data: { transferNumber: transfer.transferNumber, announced: wasAnnounced },
        });

        await this.connection.getRepository(ctx, GoodsTransfer).delete({ id: id as any });
        Logger.verbose(
            `delete: transfer ${id} (${transfer.transferNumber}) removed at ${transfer.state} — ` +
                `the number is burned, never reissued` +
                `${wasAnnounced ? ', destination told' : ''} ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return true;
    }

    // ----------------------------------------------------------------- confirm

    /**
     * Step 4 — Confirm Goods (BR-06): DRAFT → CONFIRMED, all in ONE transaction:
     *   row lock → state+lines check → pin StockLocations (T2) → PDF number →
     *   Transfer PDF → S3 asset → state+snapshots → audit → destination bell row.
     * Notification is the in-app one only — this module sends no SMS or WhatsApp.
     * PDF failure rolls EVERYTHING back — no CONFIRMED state without its document.
     */
    async confirm(ctx: RequestContext, id: ID): Promise<GoodsTransfer> {
        const repo = this.connection.getRepository(ctx, GoodsTransfer);

        // Pessimistic lock (no relations allowed with lock → two-step load).
        const locked = await repo
            .createQueryBuilder('transfer')
            .setLock('pessimistic_write')
            .where('transfer.id = :id', { id })
            .getOne();
        if (!locked) {
            throw new UserInputError(`Goods transfer ${id} not found`);
        }
        this.channelService.assertSourceChannel(ctx, locked);
        // REQUESTED too: a source that agrees with the ask as it stands should not have
        // to save an unchanged edit first just to reach DRAFT. Confirming is the same
        // acceptance, said once.
        this.assertState(locked, [TransferState.Requested, TransferState.Draft], 'confirm goods');

        const lines = await this.connection
            .getRepository(ctx, GoodsTransferLine)
            .find({ where: { transferId: id as any } });
        if (lines.length === 0) {
            throw new UserInputError('Cannot confirm: the transfer has no lines');
        }

        // A draft can sit for days. In that time the Admin Team may pull a product
        // out of the destination branch or disable it — and stock landing on an item
        // that branch cannot sell is worse than a blocked confirm. Re-check now,
        // while the transfer can still be edited.
        await this.assertLinesStillTransferable(ctx, lines, locked.destinationChannelId);

        // T2: pin the DESTINATION StockLocation now — later channel config edits can
        // never redirect this in-flight transfer.
        //
        // The SOURCE location is deliberately not resolved: the source is a dispatch
        // point, not an inventory-managed location, so its stock is never read or
        // written (SPEC §1/§6). Resolving it here could only ever FAIL a confirm — a
        // source branch with no matching StockLocation would be blocked for a value
        // nothing consumes.
        //
        // Branches that share a stock base pin THAT location instead — see
        // resolveSharedStockLocation. Receipt re-checks it, so the pin only decides
        // what the screen shows until then.
        const destinationLocation =
            (await this.channelService.resolveSharedStockLocation(
                ctx,
                locked.sourceChannelId,
                locked.destinationChannelId,
            )) ??
            (await this.channelService.resolveStockLocationForChannel(ctx, locked.destinationChannelId));

        const sourceCode = await this.getChannelCode(ctx, locked.sourceChannelId);
        const userName = await this.userName(ctx);

        // Transfer PDF — generated inside the transaction (failure = full rollback).
        const asset = await this.generateDocument(ctx, locked, lines, userName);

        await repo.update(
            { id: id as any },
            {
                state: TransferState.Confirmed,
                destinationStockLocationId: destinationLocation.id,
                pdfAssetId: asset.id,
                confirmedAt: new Date(),
                confirmedByName: userName,
            },
        );

        await this.auditService.record(ctx, {
            transferId: id,
            action: 'CONFIRMED',
            fromState: TransferState.Draft,
            toState: TransferState.Confirmed,
            data: {
                destinationStockLocation: destinationLocation.name,
            },
        });

        // In-app bell for the destination branch — same transaction.
        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: locked.destinationChannelId,
            type: TransferNotificationType.TransferConfirmed,
            title: `New goods transfer ${locked.transferNumber} from ${sourceCode}`,
            refType: 'transfer',
            refId: id,
            transferNumber: locked.transferNumber,
            userName,
        });

        const confirmed = await this.findOneOrThrow(ctx, id);
        // Post-commit domain event (EventBus is transaction-aware) for any listener.
        await this.eventBus.publish(new GoodsTransferConfirmedEvent(ctx, confirmed));
        Logger.verbose(
            `confirm: transfer ${id} (${locked.transferNumber}) DRAFT -> CONFIRMED ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return confirmed;
    }

    // ---------------------------------------------------------------- dispatch

    /**
     * Step 5 — Dispatch (BR-07): CONFIRMED → DISPATCHED (goods physically left).
     * Notifies the destination that the shipment is on the way.
     */
    async dispatch(ctx: RequestContext, id: ID): Promise<GoodsTransfer> {
        const repo = this.connection.getRepository(ctx, GoodsTransfer);
        const locked = await repo
            .createQueryBuilder('transfer')
            .setLock('pessimistic_write')
            .where('transfer.id = :id', { id })
            .getOne();
        if (!locked) {
            throw new UserInputError(`Goods transfer ${id} not found`);
        }
        this.channelService.assertSourceChannel(ctx, locked);
        this.assertState(locked, [TransferState.Confirmed], 'dispatch');

        const userName = await this.userName(ctx);

        // No dispatch number is issued (SPEC §5). One lorry carries one transfer, so
        // the transfer number is the only identifier anyone needs — a second one just
        // gave two names to the same thing.
        await repo.update(
            { id: id as any },
            {
                state: TransferState.Dispatched,
                dispatchedAt: new Date(),
                dispatchedByName: userName,
            },
        );
        await this.auditService.record(ctx, {
            transferId: id,
            action: 'DISPATCHED',
            fromState: TransferState.Confirmed,
            toState: TransferState.Dispatched,
        });
        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: locked.destinationChannelId,
            type: TransferNotificationType.TransferDispatched,
            title: `Transfer ${locked.transferNumber} is on the way`,
            refType: 'transfer',
            refId: id,
            transferNumber: locked.transferNumber,
            userName,
        });

        const dispatched = await this.findOneOrThrow(ctx, id);
        await this.eventBus.publish(new GoodsTransferDispatchedEvent(ctx, dispatched));
        Logger.verbose(
            `dispatch: transfer ${id} (${locked.transferNumber}) CONFIRMED -> DISPATCHED ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return dispatched;
    }

    // --------------------------------------------------------------- receive

    /**
     * Step 5 — Receipt approval (BR-08/09): DISPATCHED → APPROVED in ONE
     * transaction: row lock → destination-channel assert → auto stock update
     * (TransferStockService) → audit (per-line old→new) → notify source.
     * The ONLY receiving decision — no reject / partial (BRS §5).
     */
    async receive(ctx: RequestContext, id: ID): Promise<GoodsTransfer> {
        const repo = this.connection.getRepository(ctx, GoodsTransfer);
        const locked = await repo
            .createQueryBuilder('transfer')
            .setLock('pessimistic_write')
            .where('transfer.id = :id', { id })
            .getOne();
        if (!locked) {
            throw new UserInputError(`Goods transfer ${id} not found`);
        }
        // Receiving side: the actor must be in the DESTINATION channel.
        if (String(ctx.channelId) !== String(locked.destinationChannelId)) {
            throw new ForbiddenError();
        }
        this.assertState(locked, [TransferState.Dispatched], 'approve receipt');

        // The only write to existing stock tables (GT-02). Every line posts stock,
        // disabled products included — see the note in TransferStockService. The one
        // exception is a product whose stock type or pool unit changed since dispatch:
        // that line is received but `skipped`, with the reason, for the Admin Team to
        // adjust by hand.
        //
        // Branches sharing one stock base post NOTHING: the goods were counted in that
        // base before they left, and adding them again on arrival counted them twice.
        // Decided here from the live channel setup rather than trusted from the pin, so
        // transfers confirmed before this rule existed — pinned to the receiving
        // branch's own location — are caught too, and re-pinned to the shared base so
        // a later damage claim deducts from where the goods are actually counted.
        const sharedLocation = await this.channelService.resolveSharedStockLocation(
            ctx,
            locked.sourceChannelId,
            locked.destinationChannelId,
        );
        const stockResults = sharedLocation ? [] : await this.stockService.applyReceipt(ctx, locked);
        const skipped = stockResults.filter(r => r.skipped);

        const userName = await this.userName(ctx);
        await repo.update(
            { id: id as any },
            {
                state: TransferState.Received,
                receivedAt: new Date(),
                receivedByName: userName,
                ...(sharedLocation ? { destinationStockLocationId: sharedLocation.id } : {}),
            },
        );
        await this.auditService.record(ctx, {
            transferId: id,
            action: 'RECEIPT_APPROVED',
            fromState: TransferState.Dispatched,
            toState: TransferState.Received,
            data: {
                stock: stockResults,
                ...(sharedLocation
                    ? { sharedStockLocation: { id: sharedLocation.id, name: sharedLocation.name } }
                    : {}),
            },
        });
        // Notify the SOURCE branch: goods accepted. If any line posted no stock, the
        // sender is told which — they are the ones who will be asked why the numbers
        // do not add up.
        const skipNote = skipped.length
            ? ` (no stock posted for ${skipped.map(r => r.productName).join(', ')} — stock type changed since dispatch, Admin Team to adjust)`
            : '';
        await this.notificationService.notifyChannel(ctx, {
            recipientChannelId: locked.sourceChannelId,
            type: TransferNotificationType.TransferReceived,
            title: sharedLocation
                ? `Transfer ${locked.transferNumber} approved at destination — stock unchanged (shared ${sharedLocation.name} stock)`
                : `Transfer ${locked.transferNumber} approved at destination — stock updated${skipNote}`,
            refType: 'transfer',
            refId: id,
            transferNumber: locked.transferNumber,
            userName,
        });

        const approved = await this.findOneOrThrow(ctx, id);
        await this.eventBus.publish(new GoodsTransferReceivedEvent(ctx, approved));
        Logger.verbose(
            `receive: transfer ${id} (${locked.transferNumber}) DISPATCHED -> RECEIVED ` +
                `[${stockResults.length - skipped.length} stock writes, ${skipped.length} skipped (stock type changed), ` +
                (sharedLocation ? `shared stock location ${sharedLocation.id} — no stock posted, ` : '') +
                `channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );
        return approved;
    }

    // ------------------------------------------------------------------- reads

    async findAll(
        ctx: RequestContext,
        options?: GoodsTransferListOptions,
    ): Promise<{ items: GoodsTransfer[]; totalItems: number }> {
        const take = Math.min(options?.take ?? 25, 100);
        const skip = options?.skip ?? 0;
        const cid = ctx.channelId;

        const qb = this.connection
            .getRepository(ctx, GoodsTransfer)
            .createQueryBuilder('transfer')
            .leftJoinAndSelect('transfer.lines', 'line')
            .orderBy('transfer.createdAt', 'DESC')
            .skip(skip)
            .take(take);

        // BR-03 channel scoping — server-side, never client-driven.
        if (options?.direction === 'outbound') {
            qb.where('transfer.sourceChannelId = :cid', { cid });
        } else if (options?.direction === 'inbound') {
            qb.where('transfer.destinationChannelId = :cid', { cid });
        } else {
            qb.where('(transfer.sourceChannelId = :cid OR transfer.destinationChannelId = :cid)', { cid });
        }
        if (options?.state) {
            qb.andWhere('transfer.state = :state', { state: options.state });
        }
        if (options?.search?.trim()) {
            qb.andWhere('transfer.transferNumber LIKE :search', {
                search: `%${options.search.trim()}%`,
            });
        }
        const [items, totalItems] = await qb.getManyAndCount();
        return { items, totalItems };
    }

    async findOneOrThrow(ctx: RequestContext, id: ID): Promise<GoodsTransfer> {
        const transfer = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .findOne({ where: { id: id as any }, relations: ['lines'] });
        if (!transfer) {
            throw new UserInputError(`Goods transfer ${id} not found`);
        }
        this.channelService.assertChannelMember(ctx, transfer);
        // A draft is the source branch still making up its mind. The list already
        // hides it from the destination; hiding it here too keeps a direct id lookup
        // from being the one way around that.
        if (transfer.state === TransferState.Draft && String(ctx.channelId) !== String(transfer.sourceChannelId)) {
            throw new ForbiddenError();
        }
        return transfer;
    }

    /**
     * Every line's product must still EXIST for the destination branch: assigned to
     * that channel and not deleted — and for PCS lines, the variant not deleted.
     *
     * `enabled` is deliberately NOT checked here. A disabled product is one the branch
     * has taken off sale, not one that has ceased to exist: the goods are still real,
     * still on the lorry, and still belong on the paperwork. Blocking the confirm would
     * mean a physical shipment could not be documented at all.
     *
     * Nor does disabled change stock any more. It once did — the line was received
     * and recorded but posted nothing — and that lost the count of goods physically
     * standing on the destination's shelf. Every line posts now; see the note in
     * TransferStockService. "Disabled" therefore means one thing only, at every point
     * in this module: not on sale to customers.
     *
     * Deleted and unassigned are still hard failures. Those are not judgement calls
     * about sellability; the row is gone, and there is nothing left to receive against.
     */
    private async assertLinesStillTransferable(
        ctx: RequestContext,
        lines: GoodsTransferLine[],
        destinationChannelId: ID,
    ): Promise<void> {
        for (const line of lines) {
            const stillThere = await this.connection
                .getRepository(ctx, Product)
                .createQueryBuilder('product')
                .innerJoin('product.channels', 'channel', 'channel.id = :channelId', {
                    channelId: destinationChannelId,
                })
                .where('product.id = :productId', { productId: line.productId })
                .andWhere('product.deletedAt IS NULL')
                .getCount();
            if (stillThere === 0) {
                throw new UserInputError(
                    `Cannot confirm: "${line.productName}" has been deleted or removed from the destination branch. ` +
                        'Remove it from this transfer, or ask the Admin Team to restore it.',
                );
            }
            if (line.productVariantId) {
                const variant = await this.connection
                    .getRepository(ctx, ProductVariant)
                    .findOne({ where: { id: line.productVariantId as any } });
                if (!variant || variant.deletedAt) {
                    throw new UserInputError(
                        `Cannot confirm: "${line.productName}" has been deleted from the destination branch. ` +
                            'Remove it from this transfer, or ask the Admin Team to restore it.',
                    );
                }
            }
        }
    }

    /**
     * Destination stock for one line right now — grams when pooled, pieces otherwise.
     * Null until the transfer is confirmed, because the stock location is only pinned
     * at that point and guessing which one it would be is worse than saying nothing.
     */
    async getLineCurrentStock(ctx: RequestContext, line: GoodsTransferLine): Promise<number | null> {
        const transfer = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .findOne({ where: { id: line.transferId as any } });
        const locationId = transfer?.destinationStockLocationId;
        if (!locationId) {
            return null;
        }
        return this.stockService.getCurrentStock(ctx, line, locationId);
    }

    /** Quantity already claimed as damaged against a line (pending + approved). */
    async getLineDamagedQty(ctx: RequestContext, lineId: ID): Promise<number> {
        const rows = await this.connection
            .getRepository(ctx, DamageRequestLine)
            .createQueryBuilder('dl')
            .innerJoin(DamageRequest, 'd', 'd.id = dl.damageRequestId')
            .where('dl.lineId = :lineId', { lineId })
            .andWhere('d.state IN (:...states)', { states: CLAIMED_DAMAGE_STATES })
            .getMany();
        return rows.reduce((sum, r) => sum + (r.damagedGrams ?? r.damagedPcs ?? 0), 0);
    }

    /**
     * Channel code for the source/destination display fields.
     * Delegates to TransferChannelService so a branch is looked up in one place only.
     */
    getChannelCode(ctx: RequestContext, channelId: ID): Promise<string> {
        return this.channelService.getChannelCode(ctx, channelId);
    }

    /**
     * The transfer document, read WITHOUT channel scoping.
     *
     * Assets in Vendure belong to channels, and this one is created by the source
     * branch — so the ordinary lookup returns nothing for the destination, which is
     * precisely the branch that needs to print the driver's paper. The id is right
     * there on the transfer and the file itself is served publicly by the asset
     * route; only the GraphQL field was hiding it.
     *
     * Access is already decided one level up: reaching this at all means the caller
     * could read the transfer, and the transfer is visible to its two branches and
     * nobody else. A document belongs to both parties to it.
     */
    async getDocument(ctx: RequestContext, assetId: ID | null | undefined): Promise<Asset | null> {
        if (!assetId) {
            return null;
        }
        return this.connection
            .getRepository(ctx, Asset)
            .findOne({ where: { id: assetId as any } });
    }

    /**
     * One printable sheet for several transfers leaving this branch — the trip note.
     *
     * Nothing is created and nothing is stored. Every transfer keeps its own permanent
     * document, its own number and its own receipt; this reprints a chosen set of them
     * together for a driver making all the drops in one run, and is built fresh each
     * time it is asked for. Storing it would mean a pile of near-identical files that
     * nothing owns and nothing ever clears: an ad-hoc print has no row to hang off,
     * unlike a transfer's own document, which is replaced in place for life.
     *
     * SOURCE-SCOPED. A trip note is the sending branch's paperwork. A destination
     * receives one consignment and signs for one number, and has no business printing
     * a sheet listing another branch's goods — so the query is fixed to the channel
     * being acted as rather than taking a source from the caller.
     *
     * Drafts are left out, for the same reason no draft has a document today: a load
     * nobody has confirmed is not a load yet, and a driver must not be handed one.
     *
     * The range is on createdAt, which is what the transfer list filters on too. The
     * screen hands over the dates it is already showing, so "print these" means the
     * transfers the person was looking at — a sheet covering a different set from the
     * rows on screen would be the harder thing to explain.
     */
    async combinedDocument(
        ctx: RequestContext,
        input: ConsignmentSelection,
    ): Promise<{
        filename: string;
        content: string;
        transferNumbers: string[];
        destinationChannelCodes: string[];
    }> {
        // The driver's paper is only ever the SENDER's — a direction of IN is ignored
        // rather than honoured, because a note listing goods arriving from three
        // branches on three lorries is not a trip.
        const { sections, channelCode: sourceChannelCode } = await this.gatherConsignments(ctx, {
            ...input,
            direction: 'OUT',
        });

        /**
         * A field for the head only when every consignment agrees on it.
         *
         * Two loads with different drivers are not one trip, and printing the first
         * one's name across the top would put a man's name against goods he is not
         * carrying — on the sheet that gets signed. When they disagree the head says
         * so and each section prints its own.
         */
        const sharedField = (pick: (s: (typeof sections)[number]) => string | null | undefined): string | null => {
            const values = new Set(sections.map(s => (pick(s) ?? '').trim()));
            const [only] = [...values];
            return values.size === 1 && only ? only : null;
        };

        const buffer = await this.pdfService.buildCombinedTransferPdf({
            date: new Date(),
            sourceChannelCode,
            driverName: sharedField(s => s.driverName),
            driverPhone: sharedField(s => s.driverPhone),
            vehicleNumber: sharedField(s => s.vehicleNumber),
            sections: sections.map(section => ({ ...section, destinationChannelCode: section.branchCode })),
        });

        const destinationChannelCodes = [...new Set(sections.map(s => s.branchCode))];
        // Named for what it is and where it is going, so a folder of these can be read
        // without opening them. The date is the day it was printed, in the branch's
        // own time zone rather than the server's.
        const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const safe = (value: string) => value.replace(/[^A-Za-z0-9-]/g, '_');
        // Named after the branches when they still fit, counted when they do not: a
        // file name listing nine of them is no longer something anyone reads.
        const where =
            destinationChannelCodes.length > 3
                ? `${destinationChannelCodes.length}branches`
                : destinationChannelCodes.map(safe).join('-');
        const filename = `TRIP-${safe(sourceChannelCode)}-${where}-${day}.pdf`;

        Logger.verbose(
            `combinedDocument: ${sections.length} transfer(s) to ${destinationChannelCodes.length} branch(es) ` +
                `[channel ${ctx.channelId}, user ${ctx.activeUserId}]`,
            loggerCtx,
        );

        return {
            filename,
            content: buffer.toString('base64'),
            transferNumbers: sections.map(section => section.transferNumber),
            destinationChannelCodes,
        };
    }

    /**
     * The same consignments as a FLAT list of lines, each carrying its LOCAL NAME.
     *
     * The local name is what decides whether two lines are the same product. The
     * branches keep separate catalogues, so the same vegetable is a different product
     * row with a different id, a different SKU and often a different English
     * spelling — Idukki's "Uzhunnu Kanji Mix" and Madurai's "Black Urad Dal Porridge
     * Mix" are one thing to load and nothing at all to match on. What they share is
     * the name a shopper reads, which is why that is the key.
     *
     * It comes from Product.customFields.localName and
     * ProductVariant.customFields.localName — the fields the Dashboard's Local Name
     * box writes to. Read LIVE rather than from the line, because a transfer line
     * snapshots only the English name; a local name filled in after the transfer was
     * raised should still make the sheet add up.
     *
     * Returned unmerged. The merge is arithmetic on these names and belongs with the
     * screen that prints them.
     */
    async loadingListRows(
        ctx: RequestContext,
        input: ConsignmentSelection,
    ): Promise<{
        channelCode: string;
        direction: 'OUT' | 'IN';
        rows: Array<{
            branchCode: string;
            transferNumber: string;
            productName: string;
            localName: string | null;
            sku: string;
            quantityPcs: number | null;
            weightGrams: number | null;
            poolUnit: string | null;
        }>;
    }> {
        // Drafts included: this is the picking sheet, wanted before anything is confirmed.
        const { sections, channelCode, direction } = await this.gatherConsignments(ctx, input, {
            includeDrafts: true,
        });
        const lines = sections.flatMap(section => section.lines);
        const localNames = await this.localNamesFor(ctx, lines);

        return {
            channelCode,
            direction,
            rows: sections.flatMap(section =>
                section.lines.map(line => ({
                    branchCode: section.branchCode,
                    transferNumber: section.transferNumber,
                    productName: line.productName,
                    localName:
                        /*
                          A counted line is a VARIANT and takes the variant's name; a
                          weighed line is entered at product level and takes the
                          product's.

                          A variant deliberately does NOT fall back to the product's
                          local name — the same rule the purchase list follows. Doing
                          so would label every pack size of one vegetable identically
                          and then add together rows a picker cannot tell apart.
                        */
                        (line.productVariantId
                            ? localNames.variant.get(String(line.productVariantId))
                            : localNames.product.get(String(line.productId))) ?? null,
                    sku: line.sku,
                    quantityPcs: line.quantityPcs,
                    weightGrams: line.weightGrams,
                    /*
                      Carried so the sheet can add lines up and label the total. Two
                      branches' rows for the same vegetable only sum when they are
                      counted the same way, and until this was here a kilogram of one
                      branch's beans and a piece count of another's were added into a
                      single meaningless figure.
                    */
                    poolUnit: line.poolUnit,
                })),
            ),
        };
    }

    /**
     * Local names for a batch of lines, read once per product and once per variant.
     *
     * A localeString custom field is stored on the TRANSLATION row, one value per
     * language, so the value is whatever the content-language switcher was set to
     * when someone typed it.
     *
     * The request's language is preferred, and any language carrying a value is
     * accepted after it. That fallback is what makes the sheet work at all: these
     * names are entered in Tamil or Malayalam while the dashboard itself is operated
     * in English, so insisting on the request's language would find nothing. Two
     * branches that filled the field in different languages simply will not match,
     * which is honest — they are different strings.
     */
    private async localNamesFor(
        ctx: RequestContext,
        lines: Array<{ productId: ID; productVariantId: ID | null }>,
    ): Promise<{ product: Map<string, string>; variant: Map<string, string> }> {
        const productIds = [...new Set(lines.map(l => String(l.productId)).filter(Boolean))];
        const variantIds = [
            ...new Set(lines.map(l => (l.productVariantId ? String(l.productVariantId) : '')).filter(Boolean)),
        ];

        /** The best local name across a row's translations, or nothing. */
        const pick = (translations: unknown): string | undefined => {
            const rows = (translations ?? []) as Array<{
                languageCode?: string;
                customFields?: { localName?: string | null };
            }>;
            if (!rows.length) {
                return undefined;
            }
            const valueOf = (row?: { customFields?: { localName?: string | null } }) =>
                (row?.customFields?.localName ?? '').trim();
            const preferred = valueOf(rows.find(r => r.languageCode === ctx.languageCode));
            return preferred || rows.map(valueOf).find(v => v) || undefined;
        };

        const product = new Map<string, string>();
        if (productIds.length) {
            const found = await this.connection.getRepository(ctx, Product).find({
                where: { id: In(productIds) as any },
                relations: ['translations'],
            });
            for (const row of found) {
                const name = pick((row as any).translations);
                if (name) {
                    product.set(String(row.id), name);
                }
            }
        }

        const variant = new Map<string, string>();
        if (variantIds.length) {
            const found = await this.connection.getRepository(ctx, ProductVariant).find({
                where: { id: In(variantIds) as any },
                relations: ['translations'],
            });
            for (const row of found) {
                const name = pick((row as any).translations);
                if (name) {
                    variant.set(String(row.id), name);
                }
            }
        }

        return { product, variant };
    }

    /**
     * The consignments between this branch and the others, in the window asked for —
     * the raw material both printed sheets are made from.
     *
     * Shared so the trip note and the loading list can never disagree about WHICH
     * transfers they cover. They present the same consignments differently; a second
     * copy of this query would eventually drift and print two sheets for one lorry
     * that do not add up to each other.
     *
     * TWO DIRECTIONS, because the same person raises both kinds of paperwork. OUT is
     * the transfers this branch is SENDING — the driver's run, the godown's picking
     * sheet. IN is what is COMING to this branch: the requests it raised, and anything
     * else on its way here. The branch on the far end is "the other branch" either
     * way, and every section is labelled with it rather than with a fixed
     * source/destination that would flip meaning between the two.
     *
     * Always scoped to the branch being acted as, on whichever side the direction
     * puts it. Naming a transfer id is not a way round that.
     */
    private async gatherConsignments(
        ctx: RequestContext,
        input: ConsignmentSelection,
        options: { includeDrafts?: boolean } = {},
    ): Promise<{
        sections: Array<{
            transferNumber: string;
            /** The far end: the destination when sending, the source when receiving. */
            branchCode: string;
            remarks: string | null;
            driverName: string | null;
            driverPhone: string | null;
            vehicleNumber: string | null;
            lines: Array<{
                productId: ID;
                productVariantId: ID | null;
                productName: string;
                sku: string;
                quantityPcs: number | null;
                weightGrams: number | null;
                poolUnit: string | null;
            }>;
        }>;
        /** The branch being acted as. */
        channelCode: string;
        direction: 'OUT' | 'IN';
    }> {
        const direction: 'OUT' | 'IN' = input.direction === 'IN' ? 'IN' : 'OUT';

        /*
          DRAFTS are included only when the caller says so, and only one caller does.

          The trip note is the driver's paper and a draft has no document by design —
          nothing has been committed to yet. The loading list is the opposite kind of
          thing: it is what the godown weighs out BEFORE any of it is confirmed, so
          refusing to show it until afterwards would withhold the sheet exactly when
          it is needed.

          A REQUEST_DRAFT is private to the branch writing it, so it appears only when
          that branch is the one asking — the IN direction — and never to the branch
          being asked, which the list screen hides it from for the same reason.
        */
        const states = options.includeDrafts
            ? [
                  ...(direction === 'IN' ? [TransferState.RequestDraft] : []),
                  TransferState.Requested,
                  TransferState.Draft,
                  TransferState.Confirmed,
                  TransferState.Dispatched,
                  TransferState.Received,
              ]
            : [TransferState.Confirmed, TransferState.Dispatched, TransferState.Received];

        const mine = direction === 'OUT' ? 't.sourceChannelId' : 't.destinationChannelId';
        const theirs = direction === 'OUT' ? 't.destinationChannelId' : 't.sourceChannelId';

        const qb = this.connection
            .getRepository(ctx, GoodsTransfer)
            .createQueryBuilder('t')
            .where(`${mine} = :me`, { me: ctx.channelId })
            .andWhere('t.state IN (:...states)', { states });

        /*
          NAMED TRANSFERS WIN over the date range, and silence it.

          A screen that has just created three transfers knows exactly which three, and
          a date window would be a guess that also swept up whatever else went out to
          those branches today. The channel check above still applies, so naming an id
          is not a way to read another branch's paperwork.
        */
        const named = (input.transferIds ?? []).filter(id => String(id ?? '').trim() !== '');
        if (named.length) {
            qb.andWhere('t.id IN (:...named)', { named });
        } else {
            const DAY = 24 * 60 * 60 * 1000;
            // The same generous defaults the list uses: a tight `to = now` falls behind
            // UTC-stored timestamps and silently drops the newest rows.
            const to = input.to ? new Date(input.to) : new Date(Date.now() + DAY);
            const from = input.from ? new Date(input.from) : new Date(Date.now() - 365 * DAY);
            qb.andWhere('t.createdAt BETWEEN :from AND :to', { from, to });

            const branches = (input.branchIds ?? []).filter(id => String(id ?? '').trim() !== '');
            if (branches.length) {
                qb.andWhere(`${theirs} IN (:...branches)`, { branches });
            }
        }

        const transfers = await qb.getMany();
        if (!transfers.length) {
            throw new UserInputError(
                options.includeDrafts
                    ? 'Nothing to print: no transfer matches that branch and date range.'
                    : 'Nothing to print: no confirmed transfer matches that branch and date range. ' +
                          'A transfer has no document until it is confirmed.',
            );
        }

        const lines = await this.connection.getRepository(ctx, GoodsTransferLine).find({
            where: { transferId: In(transfers.map(t => t.id)) as any },
            order: { id: 'ASC' },
        });
        const linesByTransfer = new Map<string, GoodsTransferLine[]>();
        for (const line of lines) {
            const key = String(line.transferId);
            const found = linesByTransfer.get(key);
            if (found) {
                found.push(line);
            } else {
                linesByTransfer.set(key, [line]);
            }
        }

        const farEnd = (t: GoodsTransfer) =>
            direction === 'OUT' ? t.destinationChannelId : t.sourceChannelId;
        const channels = await this.connection.getRepository(ctx, Channel).find({
            where: { id: In([ctx.channelId, ...transfers.map(farEnd)]) as any },
        });
        const codeOf = (channelId: ID, fallback: string) =>
            channels.find(c => String(c.id) === String(channelId))?.code ?? fallback;

        /*
          Grouped by branch, then by number.

          The driver reads this sheet one stop at a time, so a branch's consignments
          have to sit together — two loads for Idukki listed either side of the
          Coimbatore block would have him hunting back up the page at the second
          Idukki door. Within a branch the numbers run in order, which is the order
          they were raised in.
        */
        // Lines saved before units were recorded carry none, so they are filled in
        // from the product here — once, for every section — rather than left for the
        // document and the loading sheet to each guess at differently.
        for (const lines of linesByTransfer.values()) {
            await this.fillPoolUnits(ctx, lines);
        }

        const sections = transfers
            .map(t => ({
                transferNumber: t.transferNumber,
                branchCode: codeOf(farEnd(t), direction === 'OUT' ? 'destination' : 'source'),
                remarks: t.remarks,
                driverName: t.driverName,
                driverPhone: t.driverPhone,
                vehicleNumber: t.vehicleNumber,
                lines: (linesByTransfer.get(String(t.id)) ?? []).map(l => ({
                    productId: l.productId,
                    productVariantId: l.productVariantId,
                    productName: l.productName,
                    sku: l.sku,
                    quantityPcs: l.quantityPcs,
                    weightGrams: l.weightGrams,
                    poolUnit: l.poolUnit,
                })),
            }))
            .sort(
                (a, b) =>
                    a.branchCode.localeCompare(b.branchCode) ||
                    a.transferNumber.localeCompare(b.transferNumber),
            );

        return { sections, channelCode: codeOf(ctx.channelId, 'this branch'), direction };
    }

    // ---------------------------------------------------------------- privates

    /**
     * Take a write lock on the transfer row and return the CURRENT state.
     *
     * Anything that reads the state and then acts on it must go through here.
     * Reading unlocked and deciding afterwards is a time-of-check to time-of-use
     * hole: two requests on the same transfer each see a stale snapshot, both pass
     * their state check, and both write. The lock makes the second one wait and then
     * fail its own check honestly.
     *
     * The caller still applies its own channel and state rules — this only guarantees
     * they are applied to a value nobody else can change underneath.
     */
    private async lockTransfer(ctx: RequestContext, id: ID): Promise<GoodsTransfer> {
        // A lock query cannot carry relations, so lines are loaded by the caller.
        const locked = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .createQueryBuilder('transfer')
            .setLock('pessimistic_write')
            .where('transfer.id = :id', { id })
            .getOne();
        if (!locked) {
            throw new UserInputError(`Goods transfer ${id} not found`);
        }
        this.channelService.assertChannelMember(ctx, locked);
        return locked;
    }

    private assertState(transfer: GoodsTransfer, allowed: TransferState[], action: string): void {
        const error = transferStateError(transfer.state, allowed, action);
        if (error) {
            throw new IllegalOperationError(error as any);
        }
    }

    /** Loads product (+variant for PCS lines) from the existing Product Master — read-only (BR-05/17). */
    private async loadProductForLine(
        ctx: RequestContext,
        raw: RawLineInput,
        index: number,
        destinationChannelId: ID,
    ): Promise<{ product: Product; variant: ProductVariant | null }> {
        if (raw.productVariantId !== null && raw.productVariantId !== undefined && raw.productVariantId !== '') {
            const variant = await this.connection.getRepository(ctx, ProductVariant).findOne({
                where: { id: raw.productVariantId as any },
                relations: ['product', 'translations'],
            });
            if (!variant || variant.deletedAt) {
                throw new UserInputError(`Line ${index + 1}: product variant ${raw.productVariantId} not found`);
            }
            const product = await this.loadProduct(ctx, variant.productId, index, destinationChannelId);
            return { product, variant: this.translateVariant(ctx, variant) };
        }
        if (raw.productId === null || raw.productId === undefined || raw.productId === '') {
            throw new UserInputError(`Line ${index + 1}: productId (pool) or productVariantId (PCS) is required`);
        }
        const product = await this.loadProduct(ctx, raw.productId, index, destinationChannelId);
        return { product, variant: null };
    }

    private async loadProduct(
        ctx: RequestContext,
        productId: ID | string | number,
        index: number,
        destinationChannelId: ID,
    ): Promise<Product> {
        const product = await this.connection.getRepository(ctx, Product).findOne({
            where: { id: productId as any },
            relations: ['translations'],
        });
        if (!product || product.deletedAt) {
            throw new UserInputError(`Line ${index + 1}: product ${productId} not found`);
        }
        // Destination-channel enforcement (Q1 flip): you can only transfer products
        // the DESTINATION branch actually stocks — the goods must land on a product
        // that branch can display/sell. A product not in the destination channel is
        // rejected here (a Product Master administration matter, BR-05/17).
        const inDestinationChannel = await this.connection
            .getRepository(ctx, Product)
            .createQueryBuilder('product')
            .innerJoin('product.channels', 'channel', 'channel.id = :channelId', {
                channelId: destinationChannelId,
            })
            .where('product.id = :productId', { productId })
            .getCount();
        if (inDestinationChannel === 0) {
            throw new UserInputError(
                `Line ${index + 1}: "${this.translatedName(ctx, product)}" is not available in the destination branch — ` +
                    'it cannot be transferred there. Ask the Admin Team to add it to the destination branch first.',
            );
        }
        return product;
    }

    private isPooledProduct(product: Product): boolean {
        // MySQL tinyint(1) can surface as 1/'1' instead of true — truthy check required.
        const v = (product.customFields as { productStockEnabled?: boolean | number | string } | undefined)
            ?.productStockEnabled;
        return v === true || v === 1 || v === '1';
    }

    /** Source-language name snapshot (Q2: entry-time name; destination display is live via its own token). */
    private translatedName(ctx: RequestContext, product: Product): string {
        const translations = (product as any).translations as Array<{
            languageCode: string;
            name: string;
        }>;
        const match = translations?.find(t => t.languageCode === ctx.languageCode) ?? translations?.[0];
        return match?.name ?? `Product #${product.id}`;
    }

    private translateVariant(ctx: RequestContext, variant: ProductVariant): ProductVariant {
        const translations = (variant as any).translations as Array<{
            languageCode: string;
            name: string;
        }>;
        const match = translations?.find(t => t.languageCode === ctx.languageCode) ?? translations?.[0];
        if (match?.name) {
            (variant as any).name = match.name;
        }
        return variant;
    }

    private async userName(ctx: RequestContext): Promise<string> {
        const userId = ctx.activeUserId;
        if (!userId) return '<unknown>';
        const admin = await this.administratorService.findOneByUserId(ctx, userId);
        return admin ? `${admin.firstName} ${admin.lastName}`.trim() : '<unknown>';
    }
}
