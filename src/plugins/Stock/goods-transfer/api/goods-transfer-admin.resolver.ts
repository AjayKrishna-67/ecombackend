import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, ID, Permission, RequestContext, Transaction } from '@vendure/core';

import {
    approveGoodsTransferReceiptPermission,
    approveTransferDamagePermission,
    goodsTransferPermission,
    recordTransferDamagePermission,
    viewTransferReportsPermission,
} from '../permissions';
import { fromBase, toKg } from '../../shared/stock-units';
import { DEFAULT_POOL_UNIT, isWeightPoolUnit } from '../services/pool-unit.helper';
import { DamageRequestLine } from '../entities/damage-request-line.entity';
import { GoodsTransfer } from '../entities/goods-transfer.entity';
import { GoodsTransferLine } from '../entities/goods-transfer-line.entity';
import { TransferNotificationType } from '../types';
import { DamageService, DamageLineInput } from '../services/damage.service';
import { ConsignmentSelection, GoodsTransferService } from '../services/goods-transfer.service';
import { RawLineInput } from '../services/goods-transfer.helpers';
import { ReportInput, TransferReportService, TransferReportStatus } from '../services/transfer-report.service';
import { TransferAuditService } from '../services/transfer-audit.service';
import { TransferNotificationService } from '../services/transfer-notification.service';

/**
 * Field resolvers on GoodsTransfer — channel codes plus the nested history, stock
 * and damage, so the detail screen and the damage screen are both ONE query.
 */
@Resolver('GoodsTransfer')
export class GoodsTransferEntityResolver {
    constructor(
        private goodsTransferService: GoodsTransferService,
        private auditService: TransferAuditService,
        private damageService: DamageService,
        private notificationService: TransferNotificationService,
    ) {}

    @ResolveField()
    sourceChannelCode(@Ctx() ctx: RequestContext, @Parent() transfer: GoodsTransfer) {
        return this.goodsTransferService.getChannelCode(ctx, transfer.sourceChannelId);
    }

    @ResolveField()
    destinationChannelCode(@Ctx() ctx: RequestContext, @Parent() transfer: GoodsTransfer) {
        return this.goodsTransferService.getChannelCode(ctx, transfer.destinationChannelId);
    }

    /**
     * Resolved here rather than joined, so the list screen — which never asks for the
     * document — pays nothing for it. Null while the transfer is still a draft,
     * because no document exists until confirm.
     *
     * Read through the service, which deliberately ignores channel scoping: the asset
     * belongs to the source branch, and the destination is the one holding the paper.
     */
    @ResolveField()
    pdfAsset(@Ctx() ctx: RequestContext, @Parent() transfer: GoodsTransfer) {
        return this.goodsTransferService.getDocument(ctx, transfer.pdfAssetId);
    }

    /**
     * Alerts for the caller's channel, not for this transfer — the same list the
     * report carries. Offered here so a detail screen shows them too; a user who
     * stays on one transfer should still hear about the others.
     */
    @ResolveField()
    alerts(@Ctx() ctx: RequestContext, @Args() args: { alertsAfterId?: ID | null }) {
        return this.notificationService.getAlertsAfter(ctx, args.alertsAfterId ?? null);
    }

    @ResolveField()
    audit(
        @Ctx() ctx: RequestContext,
        @Parent() transfer: GoodsTransfer,
        @Args() args: { skip?: number; take?: number },
    ) {
        // Reachable only through a transfer the caller could already read.
        return this.auditService.getForTransfer(ctx, transfer.id, { skip: args.skip, take: args.take });
    }

    @ResolveField()
    damageRequests(@Ctx() ctx: RequestContext, @Parent() transfer: GoodsTransfer) {
        return this.damageService.getDamageRequests(ctx, transfer.id);
    }
}

/**
 * Per-line figures the damage screen needs — resolved here so they cost nothing
 * on the list screen, which never asks for them.
 */
@Resolver('GoodsTransferLine')
export class GoodsTransferLineEntityResolver {
    constructor(private goodsTransferService: GoodsTransferService) {}

    @ResolveField()
    currentStock(@Ctx() ctx: RequestContext, @Parent() line: GoodsTransferLine) {
        return this.goodsTransferService.getLineCurrentStock(ctx, line);
    }

    @ResolveField()
    damagedQty(@Ctx() ctx: RequestContext, @Parent() line: GoodsTransferLine) {
        return this.goodsTransferService.getLineDamagedQty(ctx, line.id);
    }

    /**
     * What this line's pool is counted in.
     *
     * The line's own snapshot when it has one. Lines saved before units were recorded
     * have none, and those fall back to what the PRODUCT says today rather than to a
     * constant — a constant would have to be kilograms, which is precisely the wrong
     * answer for the counted products this whole change is about. Every draft in the
     * system predates the column, so this fallback is what they are all read through
     * until they are next saved.
     *
     * It agrees with TransferStockService, which treats a missing snapshot the same
     * way: nothing to compare against, so trust the live value.
     */
    @ResolveField()
    poolUnit(@Ctx() ctx: RequestContext, @Parent() line: GoodsTransferLine): Promise<string> | string | null {
        if (!line.isPooled) {
            return null;
        }
        return line.poolUnit ?? this.goodsTransferService.poolUnitForProduct(ctx, line.productId);
    }

    /**
     * The stored base integer read back in the line's OWN unit (SPEC §6). Derived on
     * the way out rather than stored, so the base value stays the single source of
     * truth and the two can never disagree. Null on a PCS line, which has no pool.
     *
     * This is the field screens should read. It is right for every pool, where
     * weightKg below is right only for the weighed ones.
     */
    @ResolveField()
    async poolQty(@Ctx() ctx: RequestContext, @Parent() line: GoodsTransferLine): Promise<number | null> {
        if (line.weightGrams == null) {
            return null;
        }
        return fromBase(line.weightGrams, await this.effectiveUnit(ctx, line));
    }

    /**
     * The same figure in kg, for callers that predate poolQty.
     *
     * NULL on anything not actually weighed, rather than grams-divided-by-a-thousand.
     * Returning 0.03 kg for thirty lemons would be a number nobody measured, and a
     * screen printing it would repeat the error this field's old behaviour caused.
     * Null makes such a caller show nothing, which is visible, instead of something
     * plausible and wrong.
     */
    @ResolveField()
    async weightKg(@Ctx() ctx: RequestContext, @Parent() line: GoodsTransferLine): Promise<number | null> {
        if (line.weightGrams == null || !isWeightPoolUnit(await this.effectiveUnit(ctx, line))) {
            return null;
        }
        return toKg(line.weightGrams);
    }

    /** The snapshot, or the product's live unit when there is none. */
    private effectiveUnit(ctx: RequestContext, line: GoodsTransferLine): Promise<string> | string {
        return line.poolUnit ?? this.goodsTransferService.poolUnitForProduct(ctx, line.productId);
    }
}

/**
 * The damage line's stored base integer read back in its own unit.
 *
 * Unlike the transfer line above, a missing snapshot here falls back to a CONSTANT
 * rather than to the product's live unit. A damage claim is a closed historical
 * record, not something anyone is still editing, and re-deriving its unit from a
 * product that may have been re-authored since would silently restate what was
 * decided. The two claims in the system predate this column and keep reading exactly
 * as they always have; every claim raised from now on carries the unit of the line
 * it was made against.
 */
@Resolver('DamageRequestLine')
export class DamageRequestLineEntityResolver {
    @ResolveField()
    damagedPoolQty(@Parent() line: DamageRequestLine): number | null {
        return line.damagedGrams == null
            ? null
            : fromBase(line.damagedGrams, line.poolUnit ?? DEFAULT_POOL_UNIT);
    }

    @ResolveField()
    damagedKg(@Parent() line: DamageRequestLine): number | null {
        if (line.damagedGrams == null || !isWeightPoolUnit(line.poolUnit ?? DEFAULT_POOL_UNIT)) {
            return null;
        }
        return toKg(line.damagedGrams);
    }
}

/**
 * Single admin resolver — thin delegation only (house convention).
 *
 * One mutation per action, named for what it does: saveDraftGoodsTransfer builds the
 * draft, confirm/dispatch/revert/approve move it. Each carries its own @Allow, so
 * what a role can do is readable straight off the decorator — a manager who may
 * confirm and dispatch still cannot revert or approve a receipt.
 * Channel/direction asserts live in the services.
 */
@Resolver()
export class GoodsTransferAdminResolver {
    constructor(
        private goodsTransferService: GoodsTransferService,
        private notificationService: TransferNotificationService,
        private damageService: DamageService,
        private reportService: TransferReportService,
    ) {}

    // ---------------------------------------------------------------- queries

    /** List screen, report tabs and search — one read. */
    @Query()
    @Allow(goodsTransferPermission.Read, viewTransferReportsPermission.Permission, Permission.SuperAdmin)
    goodsTransfers(
        @Ctx() ctx: RequestContext,
        @Args() args: { status?: TransferReportStatus; input?: ReportInput },
    ) {
        return this.reportService.report(ctx, args.input ?? {}, args.status ?? 'ALL');
    }

    /** Detail screen — lines, stock, audit and damage all come with it. */
    @Query()
    @Allow(goodsTransferPermission.Read, Permission.SuperAdmin)
    goodsTransfer(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.goodsTransferService.findOneOrThrow(ctx, args.id);
    }

    /**
     * The expiry screen — products, not transfers.
     *
     * Same permissions as the report tab it replaces: reading what is ageing on your
     * own shelf is reading, and anyone allowed to see the transfers may see this.
     */
    @Query()
    @Allow(goodsTransferPermission.Read, viewTransferReportsPermission.Permission, Permission.SuperAdmin)
    expiringProducts(
        @Ctx() ctx: RequestContext,
        @Args() args: { input?: { skip?: number | null; take?: number | null } },
    ) {
        return this.reportService.expiringProducts(ctx, args.input ?? {});
    }

    /**
     * Products of the branch chosen in the Ship-To dropdown.
     *
     * The dropdown itself is the project's existing `getChannelList` query — this
     * module does not publish one of its own. Picking your own branch is refused here
     * as well as on create, so the list can come from anywhere without the rule
     * depending on it.
     */
    @Query()
    @Allow(goodsTransferPermission.Read, goodsTransferPermission.Create, Permission.SuperAdmin)
    searchTransferProducts(
        @Ctx() ctx: RequestContext,
        @Args() args: { destinationChannelId: ID; search?: string; take?: number },
    ) {
        return this.goodsTransferService.searchTransferProducts(
            ctx,
            args.destinationChannelId,
            args.search,
            args.take,
        );
    }

    /**
     * The trip note — several of this branch's transfers printed on one sheet.
     *
     * Guarded by READ, not create or update: printing what is already there changes
     * nothing. The service fixes the source to the channel being acted as, so there is
     * no branch argument to check here.
     */
    @Query()
    @Allow(goodsTransferPermission.Read, viewTransferReportsPermission.Permission, Permission.SuperAdmin)
    combinedTransferDocument(
        @Ctx() ctx: RequestContext,
        @Args() args: { input?: ConsignmentSelection },
    ) {
        return this.goodsTransferService.combinedDocument(ctx, args.input ?? {});
    }

    /**
     * The lines behind the loading list, unmerged.
     *
     * Same guard and same selection as the trip note: this shows nothing the caller
     * could not already read one transfer at a time.
     */
    @Query()
    @Allow(goodsTransferPermission.Read, viewTransferReportsPermission.Permission, Permission.SuperAdmin)
    transferLoadingList(
        @Ctx() ctx: RequestContext,
        @Args() args: { input?: ConsignmentSelection },
    ) {
        return this.goodsTransferService.loadingListRows(ctx, args.input ?? {});
    }

    // ------------------------------------------------------------- the entry

    /** Start a new transfer — issues the transfer number that is kept for life. */
    @Mutation()
    @Transaction()
    @Allow(goodsTransferPermission.Create, Permission.SuperAdmin)
    createGoodsTransfer(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            input: {
                destinationChannelId: ID;
                remarks?: string | null;
                driverName?: string | null;
                driverPhone?: string | null;
                vehicleNumber?: string | null;
                lines: RawLineInput[];
            };
        },
    ) {
        return this.goodsTransferService.create(ctx, args.input);
    }

    /**
     * Ask another branch to send these products — the caller is the branch that will
     * receive them.
     *
     * Allowed to whoever can raise a transfer OR approve a receipt, because asking is
     * a RECEIVING-side act and the two roles are split down exactly that line: a
     * Receiving Manager holds Read plus the receipt permission and no Create at all.
     * Gating this on Create alone put the request behind a permission belonging to the
     * branch that sends — so the branches that actually run short could not ask.
     */
    @Mutation()
    @Transaction()
    @Allow(
        goodsTransferPermission.Create,
        approveGoodsTransferReceiptPermission.Permission,
        Permission.SuperAdmin,
    )
    createGoodsTransferRequest(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            input: {
                sourceChannelId: ID;
                remarks?: string | null;
                lines: RawLineInput[];
                send?: boolean | null;
            };
        },
    ) {
        return this.goodsTransferService.createRequest(ctx, args.input);
    }

    /**
     * Send a request saved as a draft. Same permission as raising one — the branch that
     * may ask is the branch that may finish asking.
     */
    @Mutation()
    @Transaction()
    @Allow(
        goodsTransferPermission.Create,
        approveGoodsTransferReceiptPermission.Permission,
        Permission.SuperAdmin,
    )
    sendGoodsTransferRequest(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.goodsTransferService.sendRequest(ctx, args.id);
    }

    /**
     * Correct a request that has not been sent. Same shape as updateGoodsTransfer, and
     * the same permission as raising one — the branch that may ask is the branch that
     * may fix what it asked for. REQUEST_DRAFT only.
     */
    @Mutation()
    @Transaction()
    @Allow(
        goodsTransferPermission.Create,
        approveGoodsTransferReceiptPermission.Permission,
        Permission.SuperAdmin,
    )
    updateGoodsTransferRequest(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            input: {
                id: ID;
                remarks?: string | null;
                lines?: RawLineInput[] | null;
                removeLineIds?: ID[] | null;
            };
        },
    ) {
        return this.goodsTransferService.updateRequestDraft(ctx, args.input);
    }

    /** Edit at DRAFT, CONFIRMED or DISPATCHED. Blocked once RECEIVED. */
    @Mutation()
    @Transaction()
    @Allow(goodsTransferPermission.Update, Permission.SuperAdmin)
    updateGoodsTransfer(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            input: {
                id: ID;
                remarks?: string | null;
                driverName?: string | null;
                driverPhone?: string | null;
                vehicleNumber?: string | null;
                lines?: RawLineInput[] | null;
                removeLineIds?: ID[] | null;
            };
        },
    ) {
        return this.goodsTransferService.update(ctx, args.input);
    }

    /** Delete outright — DRAFT, CONFIRMED or DISPATCHED. Refused once RECEIVED. */
    @Mutation()
    @Transaction()
    @Allow(goodsTransferPermission.Delete, Permission.SuperAdmin)
    deleteGoodsTransfer(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.goodsTransferService.deleteTransfer(ctx, args.id);
    }

    // ------------------------------------------------------- lifecycle moves

    @Mutation()
    @Transaction()
    @Allow(goodsTransferPermission.Update, Permission.SuperAdmin)
    confirmGoodsTransfer(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.goodsTransferService.confirm(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(goodsTransferPermission.Update, Permission.SuperAdmin)
    dispatchGoodsTransfer(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.goodsTransferService.dispatch(ctx, args.id);
    }

    /** The only action that writes stock — destination branch only. */
    @Mutation()
    @Transaction()
    @Allow(approveGoodsTransferReceiptPermission.Permission, Permission.SuperAdmin)
    receiveGoodsTransfer(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.goodsTransferService.receive(ctx, args.id);
    }

    // --------------------------------------------------------------- damage

    @Mutation()
    @Transaction()
    @Allow(recordTransferDamagePermission.Permission, Permission.SuperAdmin)
    createDamageRequest(
        @Ctx() ctx: RequestContext,
        @Args()
        args: {
            input: { transferId: ID; remarks?: string | null; lines: DamageLineInput[] };
            photos: any[];
        },
    ) {
        return this.damageService.createDamageRequest(ctx, { ...args.input, photos: args.photos ?? [] });
    }

    /** Approving deducts destination stock, so it is gated separately from raising. */
    @Mutation()
    @Transaction()
    @Allow(approveTransferDamagePermission.Permission, Permission.SuperAdmin)
    approveDamageRequest(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.damageService.approveDamageRequest(ctx, args.id);
    }

    @Mutation()
    @Transaction()
    @Allow(approveTransferDamagePermission.Permission, Permission.SuperAdmin)
    rejectDamageRequest(@Ctx() ctx: RequestContext, @Args() args: { id: ID }) {
        return this.damageService.rejectDamageRequest(ctx, args.id);
    }
}
