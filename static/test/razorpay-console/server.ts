/**
 * Razorpay test console server (local dev tool, not part of Vendure).
 *
 * Serves index.html and proxies /shop-api and /admin-api to the LOCAL Vendure
 * server, so the page is same-origin with Vendure: no CORS change is needed
 * (vendure-config.ts only allows a fixed list of headers, which does not include
 * x-razorpay-signature), and nothing in Vendure is added or changed.
 *
 * It also answers two read-only console endpoints:
 *   GET /console-api/config          → which Vendure it targets, and whether it was
 *                                      started by start.sh with every message channel off
 *   GET /console-api/webhook-events  → status rows of razorpay_webhook_event for one
 *                                      Razorpay order (no payload, no signature), read
 *                                      straight from the LOCAL database
 *
 * Refuses to start unless both the Vendure target and the database are on localhost.
 * Run via start.sh (recommended) or: bun static/test/razorpay-console/server.ts
 */
import { join } from 'path';
import { createPool, Pool } from 'mysql2/promise';

const CONSOLE_PORT = Number(process.env.RZP_CONSOLE_PORT ?? 4545);
const VENDURE_URL = process.env.VENDURE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PROXIED_PREFIXES = ['/shop-api', '/admin-api'];
// Response headers that must not be copied: Bun's fetch already decoded the body.
const DROPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

function assertLocal(label: string, host: string): void {
    if (!LOCAL_HOSTS.has(host)) {
        console.error(`[razorpay-console] Refusing to start: ${label} is "${host}", not localhost. This console must never touch production.`);
        process.exit(1);
    }
}

assertLocal('VENDURE_URL host', new URL(VENDURE_URL).hostname);
assertLocal('DB_HOST', process.env.DB_HOST ?? '');

const pool: Pool = createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
});

/** True only when start.sh launched this process with every outbound channel blanked. */
function isMessagingOff(): boolean {
    return (
        process.env.RZP_CONSOLE_SAFE === '1' &&
        !process.env.MSG91_AUTH_KEY &&
        !process.env.SMTP_PASSWORD &&
        !process.env.SOUTHMITHAI_SMTP_PASSWORD &&
        !process.env.SWADKERALA_SMTP_PASSWORD &&
        !process.env.ORDER_PLACED_WEBHOOK_URL
    );
}

async function proxyToVendure(req: Request, url: URL): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('accept-encoding');
    const upstream = await fetch(`${VENDURE_URL}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        redirect: 'manual',
    });
    const responseHeaders = new Headers(upstream.headers);
    DROPPED_RESPONSE_HEADERS.forEach(h => responseHeaders.delete(h));
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
}

async function readWebhookEvents(rzpOrderId: string): Promise<Response> {
    if (!/^order_[A-Za-z0-9]+$/.test(rzpOrderId)) {
        return Response.json({ error: 'rzpOrderId must look like order_XXXX' }, { status: 400 });
    }
    const [rows] = await pool.query(
        `SELECT eventId, event, status, signatureValid, error, createdAt, processedAt
           FROM razorpay_webhook_event WHERE rzpOrderId = ? ORDER BY id DESC LIMIT 25`,
        [rzpOrderId],
    );
    return Response.json({ events: rows });
}

const server = Bun.serve({
    port: CONSOLE_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
        const url = new URL(req.url);
        try {
            if (url.pathname === '/' || url.pathname === '/index.html') {
                return new Response(Bun.file(join(import.meta.dir, 'index.html')), {
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                });
            }
            if (url.pathname === '/console-api/config') {
                return Response.json({ vendureUrl: VENDURE_URL, isMessagingOff: isMessagingOff() });
            }
            if (url.pathname === '/console-api/webhook-events') {
                return await readWebhookEvents(url.searchParams.get('rzpOrderId') ?? '');
            }
            if (PROXIED_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) {
                return await proxyToVendure(req, url);
            }
            return new Response('Not found', { status: 404 });
        } catch (e: any) {
            return Response.json({ error: e?.message ?? String(e) }, { status: 502 });
        }
    },
});

console.log(`[razorpay-console] http://localhost:${server.port}  →  Vendure ${VENDURE_URL}`);
console.log(`[razorpay-console] messages ${isMessagingOff() ? 'OFF (started by start.sh)' : 'NOT GUARANTEED OFF — start everything with start.sh'}`);
