import { Injectable } from '@nestjs/common';
import { ID, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import { Brackets, In } from 'typeorm';

import { DamageRequest } from '../entities/damage-request.entity';
import { GoodsTransfer } from '../entities/goods-transfer.entity';
import { GoodsTransferLine } from '../entities/goods-transfer-line.entity';
import { TransferNotification } from '../entities/transfer-notification.entity';
import { DamageState, TransferNotificationType, TransferState } from '../types';
import { TransferNotificationService } from './transfer-notification.service';
import { fillPoolUnits } from './pool-unit.helper';
import { TransferStockService } from './transfer-stock.service';

export interface ReportInput {
    from?: string | null;
    to?: string | null;
    channelIds?: ID[] | null;
    /** Matches transfer number, driver name or driver phone. */
    search?: string | null;
    skip?: number | null;
    take?: number | null;
    /**
     * Id of the last alert this client already showed. Newer ones come back with
     * the list, so a screen learns what happened without a second call and without
     * the server tracking who has seen what.
     */
    alertsAfterId?: string | number | null;
}

/**
 * Which slice of transfers to show. The first four are transfer states; the damage
 * ones select transfers by the state of the claims raised against them, so one
 * screen with one set of tabs covers both.
 */
export type TransferReportStatus =
    | 'ALL'
    | 'REQUEST_DRAFT'
    | 'REQUESTED'
    | 'DRAFT'
    | 'CONFIRMED'
    | 'DISPATCHED'
    | 'RECEIVED'
    | 'EXPIRING_SOON'
    | 'DAMAGE_PENDING'
    /**
     * Damage that has been DECIDED — approved or rejected together.
     *
     * Both, because "settled" is the useful question and a rejection is an answer.
     * The only decided tab used to match APPROVED alone, so a transfer whose one
     * claim was rejected appeared under no tab at all: not pending, because it had
     * been decided; not approved, because it had not been. It could be reached only
     * by knowing its number and searching, and nothing on screen suggested it was
     * still there.
     */
    | 'DAMAGE_DECIDED'
    /** Approved only — for looking at the two outcomes apart. */
    | 'DAMAGE_APPROVED'
    /** Rejected only — the other half of DAMAGE_DECIDED. */
    | 'DAMAGE_REJECTED';

/**
 * The one read behind the list screen, every report tab and the search box.
 *
 * Channel scoping is server-side: you see transfers your channel is either side
 * of. A destination branch never sees DRAFT — a draft is the source branch still
 * making up its mind, and it is not yet anyone else's business.
 *
 * The summary always counts EVERY status so the tabs can show their badges, while
 * respecting the same channel, date and search filters as the rows.
 */
@Injectable()
export class TransferReportService {
    constructor(
        private connection: TransactionalConnection,
        private notificationService: TransferNotificationService,
        private stockService: TransferStockService,
    ) {}

    /**
     * Products this branch has been warned about — PRODUCTS, not transfers.
     *
     * Expiry belongs to a product on a shelf. The transfer is only how it arrived, and
     * a screen that answers "which transfers contain something ageing" makes the
     * reader open each one and work out which product was meant. So this returns one
     * row per warned LINE: what it is, how much is left, and when it runs out. The
     * transfer number comes along as the last column, because "where did this come
     * from" is a fair follow-up question — just not the first one.
     *
     * DRIVEN BY THE NOTIFICATION ROW, not by re-deciding what is expiring. The daily
     * sweep already made that judgement, stamped the line, and recorded the date it
     * computed. Recomputing here would let this screen and the notification disagree —
     * a shelf life edited after the warning went out would silently change the date on
     * screen while the person holds a phone showing the old one. One decision, one
     * source.
     *
     * A row leaves the list on whichever comes first: its stock running out, or its
     * expiry passing. Both matter, because `expiryNotifiedAt` is never cleared — with
     * neither rule a product warned about in March would still be listed in December.
     * The expiry one also bounds the list to the window where the warning can still be
     * acted on, which is what it is for: mark it down while it can still be sold.
     */
    async expiringProducts(ctx: RequestContext, input: { skip?: number | null; take?: number | null }) {
        const skip = input.skip ?? 0;
        const take = Math.min(input.take ?? 50, 200);

        // Every expiry warning this channel has received, newest first.
        const warnings = await this.connection
            .getRepository(ctx, TransferNotification)
            .find({
                where: {
                    recipientChannelId: ctx.channelId as any,
                    type: TransferNotificationType.ExpirySoon as any,
                },
                order: { id: 'DESC' },
            });
        if (!warnings.length) {
            return { totalItems: 0, items: [] };
        }

        // refId on an expiry warning is the LINE id — see PushSenderService for why
        // that is worth stating out loud.
        const lineIds = warnings.map(w => w.refId);
        const lines = await this.connection.getRepository(ctx, GoodsTransferLine).find({
            where: { id: In(lineIds as any[]) as any },
            relations: ['transfer'],
        });
        const lineById = new Map(lines.map(l => [String(l.id), l]));

        /*
          ── How much of EACH batch is still on the shelf ──

          Vendure keeps one stock number per product per location. It does not know
          which units came in on which transfer, so asking it "how many of the old
          ones are left" has no answer. Read naively, every warned line of the same
          product reports the branch's WHOLE stock: two transfers of one product, both
          claiming 23 pcs, when between them only 23 exist.

          So the stock is divided across the batches by the rule a shop actually
          follows — FIFO, oldest sold first. Which means what REMAINS is the newest.
          Allocate newest-first and the leftovers fall to the older batches:

              old batch   8 received  (18-Aug)
              new batch  18 received  (20-Aug)      26 in, 23 on the shelf → 3 sold

              new gets min(18, 23) = 18   → 5 left to place
              old gets min( 8,  5) =  5   → 0 left

          Old shows 5, new shows 18. Which is the truth, without tracking a single
          batch number.

          It is an ESTIMATE and worth naming as one: stock bought locally rather than
          transferred in is not in the received totals, so a branch topping up from a
          local supplier will see the older batch flattered. Capping each line at what
          it actually delivered keeps the error on the safe side — a row can never
          claim more than arrived on it.
        */
        interface Candidate {
            line: GoodsTransferLine;
            transfer: GoodsTransfer;
            warning: TransferNotification;
            receivedAt: Date;
            /** What this line delivered, in base units. */
            deliveredQty: number;
        }

        const now = new Date();
        const candidates: Candidate[] = [];
        for (const warning of warnings) {
            const line = lineById.get(String(warning.refId));
            const transfer = line?.transfer;
            // A line whose transfer has since been deleted leaves its warning behind.
            // Nothing to show and nothing to fix — skip it.
            if (!line || !transfer?.destinationStockLocationId) {
                continue;
            }

            /*
              PAST THE EXPIRY, THE ROW GOES.

              This screen exists for one decision: the branch sees something is nearly
              out of shelf life and marks it down so it sells. That decision can only
              be taken while the goods are still sellable, so the useful life of the
              warning is exactly the window between 80% and the expiry itself. After
              that there is nothing to price and nothing to do, and a row that stays
              only teaches people that the list is full of things they can ignore.

              It also settles the awkward question of when a warning is finished with.
              Stock reaching zero already retires one; this retires the rest, on a date
              the data itself supplies. No invented interval, nothing for anyone to
              dismiss by hand, no column to record that they did.
            */
            if (warning.expiresAt && now >= warning.expiresAt) {
                continue;
            }

            candidates.push({
                line,
                transfer,
                warning,
                receivedAt: transfer.receivedAt ?? transfer.createdAt,
                deliveredQty: line.isPooled ? (line.weightGrams ?? 0) : (line.quantityPcs ?? 0),
            });
        }

        // Batches of the same product at the same place share one stock figure, so
        // they are allocated together and nothing else.
        const groups = new Map<string, Candidate[]>();
        for (const candidate of candidates) {
            const key = candidate.line.isPooled
                ? `p${candidate.line.productId}@${candidate.transfer.destinationStockLocationId}`
                : `v${candidate.line.productVariantId}@${candidate.transfer.destinationStockLocationId}`;
            const list = groups.get(key) ?? [];
            list.push(candidate);
            groups.set(key, list);
        }

        // Lines with no unit snapshot get one from the product, so this screen's
        // stock figures read in the same unit as the transfer they came in on.
        await fillPoolUnits(
            ctx,
            this.connection,
            candidates.map(c => c.line),
        );

        const rows: Array<Record<string, unknown>> = [];
        for (const group of groups.values()) {
            // One stock read per product, not per line: every batch in the group is
            // asking about the same number.
            let unallocated = await this.stockService.getCurrentStock(
                ctx,
                group[0].line,
                group[0].transfer.destinationStockLocationId!,
            );
            if (unallocated <= 0) {
                continue;
            }

            // Newest first — see the note above.
            const newestFirst = [...group].sort(
                (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime(),
            );

            for (const candidate of newestFirst) {
                const share = Math.min(candidate.deliveredQty, unallocated);
                unallocated -= share;
                // A batch the shelf can no longer account for is gone as far as anyone
                // can tell — nothing to warn about.
                if (share <= 0) {
                    continue;
                }
                rows.push({
                    lineId: candidate.line.id,
                    productName: candidate.line.productName,
                    sku: candidate.line.sku ?? null,
                    isPooled: candidate.line.isPooled,
                    // The line's own unit: this screen prints a stock figure, and a
                    // pooled product is not necessarily a weighed one.
                    poolUnit: candidate.line.poolUnit,
                    currentStock: share,
                    receivedAt: candidate.receivedAt,
                    expiresAt: candidate.warning.expiresAt ?? null,
                    warnedAt: candidate.warning.createdAt,
                    transferId: candidate.transfer.id,
                    transferNumber: candidate.transfer.transferNumber,
                });
            }
        }

        /*
          Soonest first — the whole point of the screen is what to move today. A null
          expiry date sorts last: it cannot be acted on by date, so it must not push
          something that can further down.
        */
        rows.sort((a, b) => {
            const x = a.expiresAt ? new Date(a.expiresAt as Date).getTime() : Infinity;
            const y = b.expiresAt ? new Date(b.expiresAt as Date).getTime() : Infinity;
            return x - y;
        });

        // Paged after filtering, so `totalItems` counts what is actually shown rather
        // than every warning ever raised.
        return { totalItems: rows.length, items: rows.slice(skip, skip + take) };
    }

    async report(ctx: RequestContext, input: ReportInput, status: TransferReportStatus = 'ALL') {
        const skip = input.skip ?? 0;
        const take = Math.min(input.take ?? 25, 200);

        const [items, totalItems] = await this.scopedQb(ctx, input, status)
            .leftJoinAndSelect('t.lines', 'line')
            .orderBy('t.createdAt', 'DESC')
            .skip(skip)
            .take(take)
            .getManyAndCount();

        const damageByTransfer = await this.damageByTransfer(ctx, items.map(t => t.id));

        return {
            summary: await this.summary(ctx, input),
            // Carried on the list the screen already loads. A branch learns what the
            // other one did without a notifications query, a poll, or a held
            // connection — the read it was making anyway brings the news with it.
            alerts: await this.notificationService.getAlertsAfter(ctx, input.alertsAfterId ?? null),
            totalItems,
            items: items.map(t => ({
                id: t.id,
                transferNumber: t.transferNumber,
                state: t.state,
                sourceChannelId: t.sourceChannelId,
                destinationChannelId: t.destinationChannelId,
                driverName: t.driverName,
                driverPhone: t.driverPhone,
                vehicleNumber: t.vehicleNumber,
                createdByName: t.createdByName,
                requestedByName: t.requestedByName,
                confirmedByName: t.confirmedByName,
                dispatchedByName: t.dispatchedByName,
                receivedByName: t.receivedByName,
                createdAt: t.createdAt,
                requestedAt: t.requestedAt,
                confirmedAt: t.confirmedAt,
                dispatchedAt: t.dispatchedAt,
                receivedAt: t.receivedAt,
                itemCount: (t.lines ?? []).length,
                pdfAssetId: t.pdfAssetId,
                damageRequests: damageByTransfer.get(String(t.id)) ?? [],
            })),
        };
    }

    // --------------------------------------------------------------- privates

    /** Explicit channels are honoured for SuperAdmin only. */
    private resolveChannelIds(ctx: RequestContext, requested?: ID[] | null): ID[] {
        if (requested?.length && ctx.userHasPermissions([Permission.SuperAdmin])) {
            return requested;
        }
        return [ctx.channelId];
    }

    private dateRange(input: ReportInput): { from: Date; to: Date } {
        const DAY = 24 * 60 * 60 * 1000;
        // Generous, timezone-safe defaults: a tight `to = now` can fall behind
        // UTC-stored timestamps and silently drop the newest rows.
        const to = input.to ? new Date(input.to) : new Date(Date.now() + DAY);
        const from = input.from ? new Date(input.from) : new Date(Date.now() - 365 * DAY);
        return { from, to };
    }

    /** Channel + date + search + status — the filter every count and row share. */
    private scopedQb(ctx: RequestContext, input: ReportInput, status: TransferReportStatus) {
        const channelIds = this.resolveChannelIds(ctx, input.channelIds);
        const { from, to } = this.dateRange(input);

        const qb = this.connection
            .getRepository(ctx, GoodsTransfer)
            .createQueryBuilder('t')
            .where(
                new Brackets(b =>
                    b
                        // The source sees everything of its own EXCEPT a request the
                        // other branch is still writing. That row is private until it is
                        // sent — a draft visible to the branch being asked would already
                        // be the request it is not yet.
                        .where(
                            '(t.sourceChannelId IN (:...channelIds) AND t.state != :requestDraft)',
                            { channelIds, requestDraft: TransferState.RequestDraft },
                        )
                        // A draft belongs to the source branch alone until it is confirmed
                        // — UNLESS the destination is the branch that asked for it. A
                        // request accepted into DRAFT would otherwise vanish from the
                        // list of the branch waiting on it, right at the moment the
                        // answer arrived, and come back only at confirm.
                        .orWhere(
                            '(t.destinationChannelId IN (:...channelIds) AND (t.state != :draft OR t.requestedAt IS NOT NULL))',
                            { channelIds, draft: TransferState.Draft },
                        ),
                ),
            )
            .andWhere('t.createdAt BETWEEN :from AND :to', { from, to });

        const search = input.search?.trim();
        if (search) {
            qb.andWhere(
                new Brackets(b =>
                    b
                        .where('t.transferNumber LIKE :s')
                        .orWhere('t.driverName LIKE :s')
                        .orWhere('t.driverPhone LIKE :s')
                        /*
                          The damage number too.

                          It is issued, printed on the claim and named in every damage
                          alert — "Damage DMG-K-0008 on TRF-M-0031 approved" — and until
                          now it could not be typed into anything. Someone holding that
                          notification had no way to reach what it referred to without
                          first knowing the TRANSFER number, which the alert happens to
                          carry but a person reading it on a phone has to retype.

                          A transfer matches if any claim against it does; EXISTS rather
                          than a join so three claims do not return the transfer three
                          times.
                        */
                        .orWhere(
                            `EXISTS (SELECT 1 FROM damage_request dr
                                     WHERE dr.transferId = t.id AND dr.damageNumber LIKE :s)`,
                        ),
                ),
                { s: `%${search}%` },
            );
        }

        this.applyStatus(qb, status);
        return qb;
    }

    private applyStatus(qb: ReturnType<TransferReportService['scopedQb']>, status: TransferReportStatus): void {
        switch (status) {
            case 'ALL':
                return;
            case 'EXPIRING_SOON': {
                // Transfers holding at least one line the expiry sweep has warned
                // about. Read off expiryNotifiedAt rather than recomputing shelf life
                // here: the sweep already made that judgement, and a second copy of
                // the rule is a second answer waiting to disagree with the first.
                qb.andWhere(
                    `EXISTS (SELECT 1 FROM goods_transfer_line gl
                             WHERE gl.transferId = t.id AND gl.expiryNotifiedAt IS NOT NULL)`,
                );
                return;
            }
            case 'DAMAGE_PENDING':
            case 'DAMAGE_DECIDED':
            case 'DAMAGE_APPROVED':
            case 'DAMAGE_REJECTED': {
                /*
                  A transfer qualifies if ANY of its claims is in one of these states.
                  DAMAGE_DECIDED takes two, which is the point of it.

                  A transfer can therefore appear under more than one damage tab, and
                  that is correct rather than a leak: three claims can be raised
                  against one load and settled separately, so a transfer with one
                  approved claim and one still waiting genuinely belongs in both. The
                  pending tab is a to-do list, and something is still owed on it.
                */
                const damageStates =
                    status === 'DAMAGE_PENDING'
                        ? [DamageState.PendingApproval]
                        : status === 'DAMAGE_APPROVED'
                          ? [DamageState.Approved]
                          : status === 'DAMAGE_REJECTED'
                            ? [DamageState.Rejected]
                            : [DamageState.Approved, DamageState.Rejected];

                // EXISTS rather than a join: a transfer with three pending damage
                // requests must still appear once.
                qb.andWhere(
                    `EXISTS (SELECT 1 FROM damage_request dr WHERE dr.transferId = t.id AND dr.state IN (:...damageStates))`,
                    { damageStates },
                );
                return;
            }
            default:
                qb.andWhere('t.state = :status', { status });
        }
    }

    /** Counts for every tab, under the same channel/date/search filters. */
    private async summary(ctx: RequestContext, input: ReportInput) {
        const stateRows = await this.scopedQb(ctx, input, 'ALL')
            .select('t.state', 'state')
            .addSelect('COUNT(1)', 'count')
            .groupBy('t.state')
            .getRawMany();

        const out = {
            all: 0,
            requestDraft: 0,
            requested: 0,
            draft: 0,
            confirmed: 0,
            dispatched: 0,
            received: 0,
            damagePending: 0,
            damageDecided: 0,
            damageApproved: 0,
            damageRejected: 0,
            expiringSoon: 0,
        };
        for (const r of stateRows) {
            const n = Number(r.count) || 0;
            out.all += n;
            if (r.state === TransferState.RequestDraft) out.requestDraft = n;
            else if (r.state === TransferState.Requested) out.requested = n;
            else if (r.state === TransferState.Draft) out.draft = n;
            else if (r.state === TransferState.Confirmed) out.confirmed = n;
            else if (r.state === TransferState.Dispatched) out.dispatched = n;
            else if (r.state === TransferState.Received) out.received = n;
        }
        out.damagePending = await this.scopedQb(ctx, input, 'DAMAGE_PENDING').getCount();
        out.damageDecided = await this.scopedQb(ctx, input, 'DAMAGE_DECIDED').getCount();
        out.damageApproved = await this.scopedQb(ctx, input, 'DAMAGE_APPROVED').getCount();
        out.damageRejected = await this.scopedQb(ctx, input, 'DAMAGE_REJECTED').getCount();

        /*
          Counted by asking the expiring list itself, not by a query of its own.

          Whatever that list decides to show — the warned lines, minus the ones whose
          stock has gone, divided FIFO across batches — is what the tab has to claim.
          Two separate pieces of arithmetic would eventually disagree, and a tab
          reading "3" above a page showing two products is the kind of thing nobody
          can explain afterwards. `take: 0` is enough here: only the total is wanted.
        */
        out.expiringSoon = (await this.expiringProducts(ctx, { take: 0 })).totalItems;
        return out;
    }

    /** Damage requests for the listed transfers, in one round trip. */
    private async damageByTransfer(ctx: RequestContext, transferIds: ID[]) {
        const map = new Map<string, Array<Record<string, unknown>>>();
        if (!transferIds.length) return map;
        const requests = await this.connection.getRepository(ctx, DamageRequest).find({
            where: { transferId: In(transferIds as any[]) as any },
            relations: ['lines'],
            order: { createdAt: 'DESC' },
        });
        for (const r of requests) {
            const key = String(r.transferId);
            const list = map.get(key) ?? [];
            list.push({
                id: r.id,
                state: r.state,
                productCount: (r.lines ?? []).length,
                totalDamagedPcs: (r.lines ?? []).reduce((s, l) => s + (l.damagedPcs ?? 0), 0),
                totalDamagedGrams: (r.lines ?? []).reduce((s, l) => s + (l.damagedGrams ?? 0), 0),
                createdAt: r.createdAt,
                createdByName: r.createdByName,
                pdfAssetId: r.pdfAssetId,
            });
            map.set(key, list);
        }
        return map;
    }
}
