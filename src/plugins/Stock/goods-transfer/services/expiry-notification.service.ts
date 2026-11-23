import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import {
    ChannelService,
    ID,
    Logger,
    ProductVariant,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';
import { IsNull } from 'typeorm';

import { EXPIRY_WARNING_THRESHOLD_PCT, loggerCtx } from '../constants';
import { GoodsTransfer } from '../entities/goods-transfer.entity';
import { GoodsTransferLine } from '../entities/goods-transfer-line.entity';
import { TransferNotificationType, TransferState } from '../types';
import { evaluateExpiry, minExpiryDays } from './report.helpers';
import { TransferNotificationService } from './transfer-notification.service';
import { TransferStockService } from './transfer-stock.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often the shelf is looked at.
 *
 * The warning is meant for a MOMENT — 80% of the shelf life — so the interval is
 * the accuracy: whatever it is set to is the most the warning can ever be late. A
 * one-day product crosses 80% at 19h 12m, and a nightly sweep would only notice at
 * the next small hours, by which time the goods are past the expiry itself and
 * nobody is on a shop floor to read it anyway.
 *
 * Fifteen minutes is as precise as this needs to be — no one moves stock to the
 * minute — and costs one small query per channel per quarter hour.
 */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * A breath after boot before the first sweep, so startup is not competing with it.
 * Safe to run on every restart: the claim on each line is atomic, so the same
 * warning cannot go out twice.
 */
const FIRST_SWEEP_DELAY_MS = 30 * 1000;

/**
 * Warns the destination branch when transferred stock has used up most of its
 * shelf life. Swept every quarter of an hour.
 *
 * Two rules keep it from becoming noise:
 *  - one notification per TRANSFER LINE, claimed with a conditional update on the
 *    line itself. A line stays past its threshold every day after it first crosses
 *    it, and BOTH the server and the worker run this sweep, so the claim has to be
 *    atomic or the branch hears the same thing twice.
 *  - lines whose stock is already gone are skipped — there is nothing left to use up.
 *
 * The same product arriving on a LATER transfer is a different line and warns
 * again on its own schedule. Locally purchased stock is out of scope: this module
 * only knows when goods arrived if they arrived through a transfer.
 */
@Injectable()
export class ExpiryNotificationService implements OnApplicationBootstrap {
    private timer: NodeJS.Timeout | undefined;

    constructor(
        private connection: TransactionalConnection,
        private notificationService: TransferNotificationService,
        private stockService: TransferStockService,
        private channelService: ChannelService,
        private requestContextService: RequestContextService,
    ) {}

    onApplicationBootstrap(): void {
        // A plain timer rather than a job queue: there is no payload and nothing to
        // retry, and a sweep that is missed is simply performed by the next one.
        this.timer = setInterval(() => void this.run(), SWEEP_INTERVAL_MS);
        setTimeout(() => void this.run(), FIRST_SWEEP_DELAY_MS);
    }

    onApplicationShutdown(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }

    /**
     * Sweep every channel. Exposed so it can be triggered directly when testing —
     * waiting a day to see whether the warning works is not a workable loop.
     */
    async run(): Promise<{ notified: number }> {
        let notified = 0;
        try {
            const channels = await this.channelService.findAll(
                await this.requestContextService.create({ apiType: 'admin' }),
            );
            for (const channel of channels.items) {
                notified += await this.runForChannel(channel.id, channel.token);
            }
            if (notified > 0) {
                Logger.info(`Raised ${notified} expiry warning(s)`, loggerCtx);
            }
        } catch (err: any) {
            Logger.error(`Expiry sweep failed: ${err.message}`, loggerCtx);
        }
        return { notified };
    }

    private async runForChannel(channelId: ID, channelToken: string): Promise<number> {
        const ctx = await this.requestContextService.create({ apiType: 'admin', channelOrToken: channelToken });
        const now = new Date();

        // Only goods this branch has actually accepted can be ageing on its shelf.
        const transfers = await this.connection
            .getRepository(ctx, GoodsTransfer)
            .createQueryBuilder('t')
            .leftJoinAndSelect('t.lines', 'line')
            .where('t.destinationChannelId = :channelId', { channelId })
            .andWhere('t.state = :state', { state: TransferState.Received })
            .andWhere('line.expiryNotifiedAt IS NULL')
            .getMany();

        let notified = 0;
        for (const transfer of transfers) {
            const receivedAt = transfer.receivedAt ?? transfer.createdAt;
            const locationId = transfer.destinationStockLocationId;
            if (!locationId) continue;

            for (const line of transfer.lines ?? []) {
                if (line.expiryNotifiedAt) continue;

                const { expiryDays, currentStock } = await this.lineFacts(ctx, line, locationId);
                if (currentStock <= 0) continue;

                const verdict = evaluateExpiry(receivedAt, now, expiryDays, EXPIRY_WARNING_THRESHOLD_PCT);
                if (!verdict?.expireSoon || expiryDays == null) continue;

                // Claim the line BEFORE notifying. The server and the worker both run
                // this sweep, so a read-then-notify-then-stamp order would let both
                // pass the same line and warn the branch twice. A conditional update
                // makes the claim atomic: only the process whose UPDATE actually
                // touched a row goes on to send.
                const claim = await this.connection
                    .getRepository(ctx, GoodsTransferLine)
                    .update({ id: line.id as any, expiryNotifiedAt: IsNull() }, { expiryNotifiedAt: now });
                if (claim.affected !== 1) continue;

                await this.notificationService.notifyChannel(ctx, {
                    recipientChannelId: channelId,
                    type: TransferNotificationType.ExpirySoon,
                    title: `${line.productName} is nearing the end of its shelf life`,
                    refType: 'expiry',
                    refId: line.id,
                    transferNumber: transfer.transferNumber,
                    productName: line.productName,
                    expiresAt: new Date(receivedAt.getTime() + expiryDays * DAY_MS),
                    userName: 'System',
                });
                notified++;
            }
        }
        return notified;
    }

    /** Shelf life and remaining stock for one line, by its pool/piece nature. */
    private async lineFacts(
        ctx: RequestContext,
        line: GoodsTransferLine,
        locationId: ID,
    ): Promise<{ expiryDays: number | null; currentStock: number }> {
        // Stock is read through TransferStockService, never from StockLevelService or
        // ProductStockService directly (GT-01). Those two are the writers, and this
        // module keeps them reachable from exactly one file so that "which code can
        // change stock" stays a question a grep can answer. getCurrentStock already
        // applies the pooled/PCS split this method used to repeat.
        const currentStock = await this.stockService.getCurrentStock(ctx, line, locationId);

        if (line.isPooled) {
            const variants = await this.connection
                .getRepository(ctx, ProductVariant)
                .find({ where: { productId: line.productId as any, deletedAt: IsNull() } });
            return {
                expiryDays: minExpiryDays(
                    variants.map(v => (v.customFields as { expiryDays?: number } | undefined)?.expiryDays),
                ),
                currentStock,
            };
        }
        if (!line.productVariantId) {
            return { expiryDays: null, currentStock: 0 };
        }
        const variant = await this.connection
            .getRepository(ctx, ProductVariant)
            .findOne({ where: { id: line.productVariantId as any } });
        return {
            expiryDays: (variant?.customFields as { expiryDays?: number } | undefined)?.expiryDays ?? null,
            currentStock,
        };
    }
}
