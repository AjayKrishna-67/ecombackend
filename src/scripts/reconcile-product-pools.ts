/**
 * Rebuilds `ProductStockLevel.stockAllocated` for every product pool from the
 * orders that actually hold stock.
 *
 * The pool total is an accumulator, and it inherited three upstream bugs:
 * duplicate Razorpay settlements re-running allocation for the same order line,
 * non-atomic decrements losing writes under concurrent sales, and sales made
 * while a product's pool toggle was off (the strategy skips those, so nothing
 * gave the weight back). The result was products reserving stock against orders
 * delivered weeks earlier and reading as sold out on a full shelf.
 *
 * Those three are fixed at source; this repairs the totals they already
 * corrupted. Safe to re-run — it recomputes from scratch each time rather than
 * applying a delta.
 *
 * Dry run (default, writes nothing):  bunx ts-node src/scripts/reconcile-product-pools.ts
 * Apply:                              bunx ts-node src/scripts/reconcile-product-pools.ts --apply
 */
import { bootstrapWorker, Logger, RequestContextService, TransactionalConnection } from '@vendure/core';

import { config } from '../vendure-config';
import { ProductStockLevel } from '../plugins/Stock/product-stock/entities/product-stock-level.entity';
import { ProductStockService } from '../plugins/Stock/product-stock/services/product-stock.service';

const loggerCtx = 'ReconcilePools';

type Row = {
    productId: string;
    status: string;
    before: number;
    after: number;
};

async function run(): Promise<void> {
    const apply = process.argv.includes('--apply');
    // Never let a second app context re-run TypeORM schema sync against the live
    // DB — same guard as audit-stuck-razorpay.ts.
    (config.dbConnectionOptions as any).synchronize = false;
    const worker = await bootstrapWorker(config);
    const app = worker.app;
    const connection = app.get(TransactionalConnection);
    const productStockService = app.get(ProductStockService);
    const ctx = await app.get(RequestContextService).create({ apiType: 'admin' });

    const pools = await connection.getRepository(ctx, ProductStockLevel).find();
    Logger.info(
        `[reconcile] ${pools.length} pool rows found. Mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}`,
        loggerCtx,
    );

    const rows: Row[] = [];
    for (const pool of pools) {
        const productId = String(pool.productId);
        if (apply) {
            const result = await productStockService.reconcileAllocated(ctx, productId);
            rows.push({ productId, status: result.status, before: result.before, after: result.after });
        } else {
            // Dry run reads the same truth without writing it, so the report can
            // be reviewed before anything moves.
            const after = await productStockService.calculateAllocated(ctx, productId);
            rows.push({
                productId,
                status: after == null ? 'no-measure' : 'preview',
                before: pool.stockAllocated,
                after: after ?? pool.stockAllocated,
            });
        }
    }

    const changed = rows.filter(r => r.before !== r.after);
    const freed = changed.reduce((sum, r) => sum + (r.before - r.after), 0);
    // Sorted by size of correction: the worst offenders are the ones a human
    // should eyeball before this is applied.
    changed.sort((a, b) => b.before - b.after - (a.before - a.after));
    for (const row of changed.slice(0, 40)) {
        Logger.info(
            `[reconcile] product ${row.productId}: ${row.before} -> ${row.after} ` +
            `(${row.before - row.after > 0 ? 'freed' : 'added'} ${Math.abs(row.before - row.after)}) [${row.status}]`,
            loggerCtx,
        );
    }
    Logger.info(
        `[reconcile] ${changed.length} of ${rows.length} pools need correction; ` +
        `net ${freed} base units (grams/pieces) of phantom reservation${apply ? ' released' : ' would be released'}.`,
        loggerCtx,
    );
    if (!apply) {
        Logger.info('[reconcile] Dry run only — re-run with --apply to write.', loggerCtx);
    }
    await app.close();
    process.exit(0);
}

run().catch(e => {
    Logger.error(`[reconcile] failed: ${String(e)}`, loggerCtx);
    process.exit(1);
});
