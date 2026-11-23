/**
 * One-time audit: for every order stuck in AddingItems (or ArrangingPayment) that carries
 * a razorpayOrderId, ask Razorpay whether it actually holds money. Separates GENUINELY
 * STUCK money (captured/authorized at Razorpay, order never placed) from harmless abandoned
 * checkouts (Razorpay order created but never paid).
 *
 * Read-only: it fetches from Razorpay and prints a report. It does NOT settle or mutate
 * anything. Run: bunx ts-node src/scripts/audit-stuck-razorpay.ts
 */
import { bootstrapWorker, Order, TransactionalConnection, RequestContextService, Logger } from '@vendure/core';
import { config } from '../vendure-config';
import { RazorpaySettlementService } from '../plugins/Payment/Razorpay/service/razorpay-settlement.service';

type Row = {
    code: string;
    state: string;
    rzpOrderId: string;
    channel: string;
    verdict: 'CAPTURED' | 'AUTHORIZED' | 'UNPAID' | 'NO_CLIENT' | 'API_ERROR';
    amount?: number;
    paymentId?: string;
};

async function run(): Promise<void> {
    // Read-only audit: never let this standalone process mutate schema. The main config
    // runs synchronize:true; force it off here so bootstrapping a second app context
    // cannot re-run TypeORM schema sync against the live DB.
    (config.dbConnectionOptions as any).synchronize = false;
    const worker = await bootstrapWorker(config);
    const app = worker.app;
    const connection = app.get(TransactionalConnection);
    const requestContextService = app.get(RequestContextService);
    const settlement = app.get(RazorpaySettlementService);
    const adminCtx = await requestContextService.create({ apiType: 'admin' });
    const orders = await connection.getRepository(adminCtx, Order).find({
        where: [{ state: 'AddingItems' as any }, { state: 'ArrangingPayment' as any }],
        relations: ['channels'],
    });
    const stuck = orders.filter(o => !!(o.customFields as any).razorpayOrderId);
    Logger.info(`[AUDIT] Checking ${stuck.length} AddingItems/ArrangingPayment orders with a razorpayOrderId...`, 'RazorpayAudit');
    const rows: Row[] = [];
    for (const order of stuck) {
        const rzpOrderId = (order.customFields as any).razorpayOrderId as string;
        const channel = (order.channels || []).find(c => c.code !== '__default_channel__') || order.channels?.[0];
        const ctx = await settlement.resolveChannelContext(order);
        const client = await settlement.getRazorpayClientForCtx(ctx);
        if (!client) {
            rows.push({ code: order.code, state: order.state, rzpOrderId, channel: channel?.code ?? '?', verdict: 'NO_CLIENT' });
            continue;
        }
        try {
            const payments = await client.orders.fetchPayments(rzpOrderId);
            const captured = payments?.items?.find((p: any) => p.status === 'captured');
            const authorized = payments?.items?.find((p: any) => p.status === 'authorized');
            const hit = captured || authorized;
            rows.push({
                code: order.code, state: order.state, rzpOrderId, channel: channel?.code ?? '?',
                verdict: captured ? 'CAPTURED' : authorized ? 'AUTHORIZED' : 'UNPAID',
                amount: hit ? Number(hit.amount) / 100 : undefined,
                paymentId: hit?.id,
            });
        } catch (e: any) {
            rows.push({ code: order.code, state: order.state, rzpOrderId, channel: channel?.code ?? '?', verdict: 'API_ERROR' });
        }
    }
    const byVerdict = (v: Row['verdict']) => rows.filter(r => r.verdict === v);
    const realStuck = [...byVerdict('CAPTURED'), ...byVerdict('AUTHORIZED')];
    Logger.info('[AUDIT] ================ RESULT ================', 'RazorpayAudit');
    Logger.info(`[AUDIT] total=${rows.length}  CAPTURED=${byVerdict('CAPTURED').length}  AUTHORIZED=${byVerdict('AUTHORIZED').length}  UNPAID=${byVerdict('UNPAID').length}  NO_CLIENT=${byVerdict('NO_CLIENT').length}  API_ERROR=${byVerdict('API_ERROR').length}`, 'RazorpayAudit');
    if (realStuck.length) {
        Logger.error(`[AUDIT] ${realStuck.length} orders hold REAL money at Razorpay but are not placed:`, 'RazorpayAudit');
        for (const r of realStuck) {
            Logger.error(`[AUDIT]   ${r.verdict}  ${r.code}  ₹${r.amount}  state=${r.state}  channel=${r.channel}  ${r.rzpOrderId}  ${r.paymentId}`, 'RazorpayAudit');
        }
    } else {
        Logger.info('[AUDIT] No genuinely stuck money — all stuck orders are unpaid abandoned checkouts.', 'RazorpayAudit');
    }
    await worker.app.close();
    process.exit(0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
