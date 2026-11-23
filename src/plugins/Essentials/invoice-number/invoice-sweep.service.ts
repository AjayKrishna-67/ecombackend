import { Injectable } from '@nestjs/common';
import {
    Channel,
    Logger,
    Order,
    RequestContextService,
    TransactionalConnection,
} from '@vendure/core';

import { getFiscalYearStart } from './fiscal-year';
import { InvoiceNumberService } from './invoice-number.service';

const loggerCtx = 'InvoiceSweep';

// Pre-placement states only. Cancelled is intentionally NOT skipped: an order
// that was genuinely placed (orderPlacedAt set) then cancelled must still get
// an invoice number. The `orderPlacedAt >= fyStart` filter below already
// excludes never-placed orders, so Created/AddingItems/ArrangingPayment can't
// slip through anyway.
const SKIPPED_STATES = ['Created', 'AddingItems', 'ArrangingPayment'] as const;

@Injectable()
export class InvoiceSweepService {
    constructor(
        private readonly connection: TransactionalConnection,
        private readonly requestContextService: RequestContextService,
        private readonly invoiceNumberService: InvoiceNumberService,
    ) {}

    /**
     * Finds orders across all non-default channels that reached a settled
     * state without receiving an invoice number and assigns one via the
     * existing service. Idempotent per order — relies on the service's
     * NULL-conditional update to avoid overwriting concurrent assignments.
     */
    async sweepMissingInvoices(): Promise<void> {
        const channels = await this.connection
            .getRepository(Channel)
            .find({ where: [] });
        const nonDefault = channels.filter(c => c.code !== '__default_channel__');
        const fyStart = getFiscalYearStart(new Date());
        let totalSwept = 0;
        for (const channel of nonDefault) {
            const ctx = await this.requestContextService.create({
                apiType: 'admin',
                channelOrToken: channel,
            });
            const orderIds = await this.connection
                .getRepository(ctx, Order)
                .createQueryBuilder('o')
                .innerJoin('o.channels', 'ch', 'ch.id = :channelId', { channelId: channel.id })
                .where('o.customFields.invoiceNo IS NULL')
                .andWhere('o.state NOT IN (:...skip)', { skip: SKIPPED_STATES })
                .andWhere('o.orderPlacedAt >= :fyStart', { fyStart })
                .orderBy('o.orderPlacedAt', 'ASC')
                .addOrderBy('o.id', 'ASC')
                .select('o.id', 'id')
                .getRawMany<{ id: number }>();
            if (orderIds.length === 0) {
                continue;
            }
            let channelSwept = 0;
            for (const { id } of orderIds) {
                try {
                    await this.invoiceNumberService.assignInvoiceNumber(ctx, Number(id));
                    channelSwept++;
                    totalSwept++;
                } catch (err) {
                    Logger.error(
                        `Sweep failed for order ${id} in channel ${channel.code}: ${(err as Error).message}`,
                        loggerCtx,
                    );
                }
            }
            Logger.info(
                `Channel ${channel.code}: assigned ${channelSwept}/${orderIds.length} missing invoice(s)`,
                loggerCtx,
            );
        }
        if (totalSwept > 0) {
            Logger.warn(
                `Sweep assigned ${totalSwept} invoice number(s) — live event path missed these orders`,
                loggerCtx,
            );
        }
    }
}
