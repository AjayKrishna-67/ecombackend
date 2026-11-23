/**
 * One-time: rewrite every existing transfer document in the current layout.
 *
 * The document is generated when a transfer is confirmed and stored as an asset, so
 * changing the layout only affects transfers confirmed AFTERWARDS — everything
 * already issued keeps the file it was given. This walks those and rewrites each one
 * in place, keeping its asset id, name and URL, so a link already printed or shared
 * still resolves and simply shows the newer document.
 *
 * Safe to re-run: rewriting a document that is already current produces the same file.
 *
 * Run: bunx ts-node src/scripts/regenerate-transfer-pdfs.ts
 */
import {
    Logger,
    RequestContextService,
    TransactionalConnection,
    bootstrapWorker,
} from '@vendure/core';

import { GoodsTransfer } from '../plugins/Stock/goods-transfer/entities/goods-transfer.entity';
import { GoodsTransferLine } from '../plugins/Stock/goods-transfer/entities/goods-transfer-line.entity';
import { TransferChannelService } from '../plugins/Stock/goods-transfer/services/transfer-channel.service';
import { TransferPdfService } from '../plugins/Stock/goods-transfer/services/transfer-pdf.service';
import { config } from '../vendure-config';

const ctxName = 'RegenerateTransferPdfs';

async function run(): Promise<void> {
    // A standalone process must never re-run schema sync against the live database.
    (config.dbConnectionOptions as any).synchronize = false;
    const worker = await bootstrapWorker(config);
    const app = worker.app;

    const connection = app.get(TransactionalConnection);
    const requestContextService = app.get(RequestContextService);
    const pdfService = app.get(TransferPdfService);
    const channelService = app.get(TransferChannelService);

    const ctx = await requestContextService.create({ apiType: 'admin' });

    const transfers = await connection
        .getRepository(ctx, GoodsTransfer)
        .createQueryBuilder('t')
        .where('t.pdfAssetId IS NOT NULL')
        .orderBy('t.id', 'ASC')
        .getMany();

    Logger.info(`${transfers.length} transfer(s) hold a document — rewriting each`, ctxName);

    let done = 0;
    let failed = 0;

    for (const transfer of transfers) {
        try {
            const lines = await connection.getRepository(ctx, GoodsTransferLine).find({
                where: { transferId: transfer.id as any },
                order: { id: 'ASC' },
            });

            const [sourceCode, destinationCode] = await Promise.all([
                channelService.getChannelCode(ctx, transfer.sourceChannelId),
                channelService.getChannelCode(ctx, transfer.destinationChannelId),
            ]);

            await pdfService.generateAndStoreTransferPdf(
                ctx,
                {
                    transferNumber: transfer.transferNumber,
                    documentNumber: transfer.transferNumber,
                    // The document's own date, not today's — this is a rewrite of an
                    // existing paper, not the issue of a new one.
                    date: transfer.confirmedAt ?? transfer.createdAt,
                    sourceChannelCode: sourceCode,
                    destinationChannelCode: destinationCode,
                    preparedBy: transfer.confirmedByName ?? transfer.createdByName,
                    remarks: transfer.remarks ?? null,
                    driverName: transfer.driverName ?? null,
                    driverPhone: transfer.driverPhone ?? null,
                    vehicleNumber: transfer.vehicleNumber ?? null,
                    lines: lines.map(l => ({
                        productName: l.productName,
                        sku: l.sku,
                        quantityPcs: l.quantityPcs,
                        weightGrams: l.weightGrams,
                    })),
                },
                transfer.pdfAssetId,
            );

            done += 1;
            Logger.info(`  ${transfer.transferNumber} — rewritten (${lines.length} line(s))`, ctxName);
        } catch (err: any) {
            failed += 1;
            Logger.error(`  ${transfer.transferNumber} — FAILED: ${err.message}`, ctxName);
        }
    }

    Logger.info(`Done. ${done} rewritten, ${failed} failed.`, ctxName);
    await app.close();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    Logger.error(String(err?.stack ?? err), ctxName);
    process.exit(1);
});
