import {
  VendureConfig,
  cleanSessionsTask,
  defaultPromotionConditions,
  defaultOrderProcess,
  dummyPaymentHandler,
  NativeAuthenticationStrategy,
  MergeOrdersStrategy,
  Logger,
  LogLevel,
} from '@vendure/core';
import 'dotenv/config';
import * as path from 'path';
import { json } from 'body-parser';

import { orderCanceledNotificationProcess } from './customOrderProcess/order-canceled-notification-process';
import { PhoneOtpAuthenticationStrategy } from './plugins/Authenticated/otpmechanism/strategies/phone-otp.strategy';
import { WhatsappAuthenticationStrategy } from './plugins/Essentials/whatsapp/strategies/whatsapp-authentication.strategy';
import { GoogleAuthenticationStrategy } from './plugins/Authenticated/google-auth/google-authentication-strategy';
import { AppleAuthenticationStrategy } from './plugins/Authenticated/apple-auth/apple-authentication-strategy';
import { plugins } from './vendure-config-plugins';
import { customFields } from './vendure-config-custom-fields';
import { RelationAliasFilterLogger } from './logging/relation-alias-filter-logger';

import {
  Counter,
  Histogram,
  collectDefaultMetrics,
  register as promRegister,
} from 'prom-client';

// Default Node.js process metrics (CPU, memory, heap, GC, event loop, FDs).
// Prefix matches the Grafana dashboard queries (vendure_process_*, vendure_nodejs_*).
collectDefaultMetrics({ prefix: 'vendure_' });

// HTTP request metrics — names match the SLO recording rules in
// helm/environments/production/slo-rules.yaml (no prefix).
const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled by the Vendure server.',
  labelNames: ['method', 'route', 'status'] as const,
});
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
});

// Bucket request paths to a small fixed set so Prometheus label cardinality
// stays bounded (otherwise every product slug becomes its own series).
function bucketRoute(reqPath: string): string {
  if (!reqPath) return 'other';
  if (reqPath.startsWith('/shop-api')) return '/shop-api';
  if (reqPath.startsWith('/admin-api')) return '/admin-api';
  if (reqPath.startsWith('/assets')) return '/assets';
  if (reqPath.startsWith('/admin')) return '/admin';
  if (reqPath.startsWith('/.well-known')) return '/.well-known';
  if (reqPath === '/health') return '/health';
  if (reqPath === '/metrics') return '/metrics';
  if (reqPath === '/refer') return '/refer';
  return 'other';
}

const IS_DEV = process.env.APP_ENV === 'dev';

// The session table had grown to 4.5GB / 13.9M rows — 13.8M of them anonymous
// visits from a traffic spike that ended in June. Vendure's default of 1,000
// rows once per day can never drain a backlog that size, so the built-in task is
// retuned to run hourly.
//
// Batch size is capped at 5,000, NOT the 25,000 first tried. Vendure's
// `cleanExpiredSessions` deletes via `repository.remove(entities)`, the
// entity-aware path — because SessionService registers itself as a TypeORM
// subscriber, every batch first reloads the rows (`SELECT ... WHERE id IN (?×N)`,
// once per inheritance subclass) and then emits `DELETE ... WHERE id = ? OR ...`
// with one clause per row. At 25,000 that measured 17s and 99s per statement:
// past the 3s `maxQueryExecutionTime` log threshold, and holding a worker
// connection for ~2 minutes every hour, which starved the price-sync pool gate.
// 5,000/hour = 120k/day, still ~115 days to drain the backlog and far above the
// ~7/day arriving now.
//
// `configure()` mutates the task in place and returns `this`, and
// `defaultConfig.schedulerOptions.tasks` already holds a reference to this same
// singleton — so this statement is the whole registration. Pushing it into the
// tasks array would register a duplicate task id.
//
// Runs on the worker only (`runTasksInWorkerOnly` defaults to true), and deletes
// only what Vendure already considers dead: expired sessions, plus anonymous
// ones with no cart attached. See docs/session-table-cleanup.md.
cleanSessionsTask.configure({
  schedule: cron => cron.every(1).hours(),
  params: { batchSize: 5_000 },
});
/**
 * LOG_LEVEL from .env, defaulting to Info.
 *
 * `verbose` is the one to use when following what a plugin is doing: our own
 * Logger.verbose lines appear, and Vendure's internals stay quiet. `debug` adds
 * core's own chatter — every request logs several "CacheService hit for key
 * [vendure-session-cache:…]" lines, which buries the plugin output it was turned
 * on to read.
 */
const LOG_LEVELS: Record<string, LogLevel> = {
  error: LogLevel.Error,
  warn: LogLevel.Warn,
  info: LogLevel.Info,
  verbose: LogLevel.Verbose,
  debug: LogLevel.Debug,
};

export const config: VendureConfig = {
  // Wraps DefaultLogger to drop the false-positive relation-alias custom-field
  // warning (e.g. "addonGroupsIds not found") emitted on every relation save.
  // logger: new RelationAliasFilterLogger({
  //   level: LOG_LEVELS[(process.env.LOG_LEVEL ?? '').toLowerCase()] ?? LogLevel.Info,
  // }),
  apiOptions: {
    port: Number(process.env.PORT) || 8000,
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    adminListQueryLimit: 2000,
    shopListQueryLimit: 1000,
    ...(IS_DEV
      ? {
        adminApiPlayground: {
          settings: { 'request.credentials': 'include' } as any,
        },
        adminApiDebug: true,
        shopApiPlayground: {
          settings: { 'request.credentials': 'include' } as any,
        },
        shopApiDebug: true,
      }
      : {}),
    middleware: [
      // GLOBAL JSON body parser that also captures the RAW request bytes for the
      // Razorpay and WhatsApp webhooks (so their HMAC signatures are verified
      // against exactly what was signed — a JSON.parse -> JSON.stringify
      // round-trip changes key order/whitespace/unicode and silently breaks
      // verification).
      //
      // This MUST be global (`*splat`), not scoped to the webhook route: a
      // `beforeListen` json parser REPLACES Vendure/NestJS's own global body
      // parser (Nest skips its default once a json parser is present). Scoping it
      // to one route would leave admin-api/shop-api with no body parser at all
      // ("POST body missing"). The `verify` hook stashes rawBody only for the
      // webhook paths, so every other route parses exactly as before.
      //
      // Match on req.originalUrl, NOT req.url: Vendure mounts this with
      // app.use('*splat', ...), and Express strips the matched mount path from
      // req.url — inside this hook req.url is always "/".
      {
        route: '*splat',
        beforeListen: true,
        handler: json({
          limit: '10mb',
          verify: (req: any, _res: any, buf: Buffer) => {
            const url: string = req.originalUrl ?? req.url ?? '';
            if (url.includes('/razorpay/webhook') || url.includes('/whatsapp/webhook')) {
              req.rawBody = buf;
            }
          },
        }),
      },
      // One terminal line per GraphQL request, for watching a flow in the
      // Playground while it happens. OFF unless BOTH APP_ENV=dev and
      // LOG_REQUESTS=true — two gates, because something you must remember to
      // disable before pushing is something that will one day get pushed. .env is
      // gitignored and .env.example deliberately does not mention LOG_REQUESTS,
      // so a fresh clone is silent until somebody opts in on purpose.
      //
      // Placed AFTER the json parser above so req.body is already parsed; the
      // operation name is read from the query text rather than the resolver,
      // because middleware runs before Apollo has decided anything.
      ...(IS_DEV && process.env.LOG_REQUESTS === 'true'
        ? [
          {
            route: '/',
            handler: (req: any, res: any, next: any) => {
              const url: string = req.originalUrl || req.url || '';
              if (req.method !== 'POST' || !/\/(admin|shop)-api/.test(url)) {
                return next();
              }
              const query: string = req.body?.query ?? '';
              // "mutation login{ login(...)" -> "login". Falls back to the raw
              // first field when the document is unnamed.
              const op =
                query.match(/(?:query|mutation)\s+\w*\s*(?:\([^)]*\))?\s*{\s*(\w+)/)?.[1] ??
                query.match(/{\s*(\w+)/)?.[1] ??
                '?';
              // The Playground re-runs introspection on almost every keystroke.
              // Left in, it is most of the log and none of the information.
              if (op.startsWith('__') || query.includes('IntrospectionQuery')) {
                return next();
              }
              const channel = req.headers['vendure-token'] ?? '-';
              const started = Date.now();
              res.on('finish', () => {
                Logger.info(
                  `${String(op).padEnd(24)} ${String(channel).padEnd(14)} ` +
                  `${res.statusCode} ${Date.now() - started}ms`,
                  'gql',
                );
              });
              next();
            },
          },
        ]
        : []),
      // Prometheus HTTP timing — observes every request, labels are bucketed
      // (see bucketRoute above) to keep label cardinality bounded.
      {
        route: '/',
        handler: (req: any, res: any, next: any) => {
          // Capture URL/method BEFORE next(): Apollo Server (used for
          // /shop-api and /admin-api) mutates req.path during GraphQL
          // handling, so reading it inside res.on('finish') buckets the
          // request as 'other'. originalUrl is preserved by Express
          // exactly for this case.
          const rawUrl: string = req.originalUrl || req.url || req.path || '';
          const reqPath = rawUrl.split('?')[0];
          const method: string = req.method;
          const start = process.hrtime.bigint();
          res.on('finish', () => {
            const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
            const labels = {
              method,
              route: bucketRoute(reqPath),
              status: String(res.statusCode),
            };
            httpRequestsTotal.inc(labels);
            httpRequestDuration.observe(labels, durationSec);
          });
          next();
        },
      },
      // /metrics endpoint scraped by Prometheus (annotation already points here).
      {
        route: '/metrics',
        handler: async (req: any, res: any, next: any) => {
          if (req.method !== 'GET') return next();
          try {
            res.setHeader('Content-Type', promRegister.contentType);
            res.end(await promRegister.metrics());
          } catch (err) {
            res.status(500).end((err as Error).message);
          }
        },
      },
      {
        route: '/.well-known',
        handler: require('express').static(path.join(__dirname, '..', 'static', '.well-known'), {
          setHeaders: (res: any) => {
            res.setHeader('Content-Type', 'application/json');
          },
        }),
      },
      {
        route: '/refer',
        handler: (req: any, res: any, next: any) => {
          if (req.method !== 'GET') return next();
          const referrerId = req.query.referrerId || '';
          res.setHeader('Content-Type', 'text/html');
          res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Kaaikani Referral</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#f5f5f5}
    .card{background:#fff;border-radius:16px;padding:32px;max-width:400px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.1)}
    h1{color:#333;font-size:22px}p{color:#666;font-size:15px;line-height:1.5}
    .btn{display:inline-block;background:#FF6B00;color:#fff;padding:14px 32px;border-radius:28px;text-decoration:none;font-weight:600;font-size:16px;margin-top:16px}
  </style>
</head>
<body>
  <div class="card">
    <h1>You've been invited to Kaaikani!</h1>
    <p>Download the app and sign up to earn referral rewards.</p>
    <a class="btn" href="https://play.google.com/store/apps/details?id=com.kaaikani.kaaikani">Download App</a>
  </div>
  <script>window.location.href='kaaikani://refer?referrerId=${referrerId}';</script>
</body>
</html>`);
        },
      },
    ],
    cors: {
      // Explicitly listing allowedHeaders disables the cors package's default
      // header-reflection, so content-type and authorization MUST be listed
      // here or browser preflight (OPTIONS) requests from the dashboard fail.
      allowedHeaders: ['content-type', 'authorization', 'vendure-token', 'x-device-medium', 'x-platform'],
      origin: true,
      credentials: true,
    },
  },
  authOptions: {
    tokenMethod: ['bearer', 'cookie'],
    superadminCredentials: {
      identifier: process.env.SUPERADMIN_USERNAME,
      password: process.env.SUPERADMIN_PASSWORD,
    },
    shopAuthenticationStrategy: [
      new PhoneOtpAuthenticationStrategy(),
      new WhatsappAuthenticationStrategy(),
      new NativeAuthenticationStrategy(),
      new GoogleAuthenticationStrategy(process.env.GOOGLE_CLIENT_ID as string),
      new AppleAuthenticationStrategy([
        {
          // South Mithai iOS app
          channelTokens: ['ind-Snacks', 'Ind-Snacks'],
          clientId: process.env.APPLE_CLIENT_ID_SOUTHMITHAI as string,
        },
        {
          // Swad Kerala iOS app
          channelTokens: ['ind-Swadkerala', 'Ind-Swadkerala'],
          clientId: process.env.APPLE_CLIENT_ID_SWADKERALA as string,
        },
        {
          // Kaaikani app (city channels + shared channels)
          channelTokens: ['ind-madurai', 'ind-salem', 'ind-coimbatore', 'ind-trichy', 'ind-Snacks', 'Ind-Snacks', 'ind-Swadkerala', 'Ind-Swadkerala'],
          clientId: process.env.APPLE_CLIENT_ID_DEFAULT as string,
        },
        {
          // Kaaikani Direct iOS app
          channelTokens: ['kaaikanidirect-coimbatore'],
          clientId: process.env.APPLE_CLIENT_ID_KAAIKANIDIRECT as string,
        },
        {
          // Sip n Nourish iOS app
          channelTokens: ['sipnnnourish-coimbatore'],
          clientId: process.env.APPLE_CLIENT_ID_SIPNNOURISH as string,
        },
        {
          // Default channel (dev / testing — no vendure-token header sent)
          channelTokens: ['d7476xruz8xpzmkjsa6l'],
          clientId: process.env.APPLE_CLIENT_ID_DEFAULT as string,
        },
      ]),
    ],
    cookieOptions: {
      secret: process.env.COOKIE_SECRET,
    },
    requireVerification: true,
  },
  dbConnectionOptions: {
    type: 'mysql',
    // NEVER true: synchronize lets TypeORM fire arbitrary DDL at connect time
    // (it was attempting FK-backed index drops that MySQL rejects, crashing
    // boot). Schema changes go through generated migrations only.
    synchronize: true,
    // Surface failed queries + warnings (NOT every query — 'query'/true would
    // flood logs in prod). maxQueryExecutionTime logs the SQL+params of any query
    // slower than 3s, so slow reports are visible BEFORE the 15s timeout aborts
    // them. Observability only — does not abort or change results.
    logging: ['error', 'warn'],
    maxQueryExecutionTime: 3000,
    migrations: [path.join(__dirname, './migrations/*.+(js|ts)')],
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    timezone: 'Z', // Force UTC to avoid timezone mismatches
    extra: {
      // Connection pool — db.t3.small max_connections ≈ 170
      // Budget: 4 server pods × 30 + worker 20 + admin/migration buffer 20 = 160 / 170
      connectionLimit: 30,
      connectTimeout: 10000,
      waitForConnections: true,
      // Keep connections alive to avoid reconnection latency
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    },
  },
  paymentOptions: {
    paymentMethodHandlers: [dummyPaymentHandler],
  },
  customFields,
  plugins,
  orderOptions: {
    process: [defaultOrderProcess, orderCanceledNotificationProcess],
    mergeStrategy: new MergeOrdersStrategy(),
  },
};
