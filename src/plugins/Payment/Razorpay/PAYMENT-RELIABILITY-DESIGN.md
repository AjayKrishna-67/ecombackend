# Razorpay Payment Reliability — Design Doc

**Date:** 2026-07-14
**Author:** office-hours session (KaaiKani Vendure)
**Status:** Approved direction — "Full durable pipeline" (Approach B). Not yet implemented.
**Scope:** Rearchitect the Razorpay plugin so money-captured orders never strand, and new bugs stop appearing every release.

---

## 1. Problem

Customers pay (Razorpay/UPI captures the money), but the Vendure order stays in `AddingItems`/`ArrangingPayment` with no placed order. Every fix spawns a new variant of the same failure. Two confirmed incidents: orders `41STU77XB6K8Z373` and `Z3X5QKF59E83HKP9` — both had **2 payment attempts (attempt-1 failed, attempt-2 captured)** and both stranded.

## 2. Root cause (why it recurs)

Not "payments are hard." Three structural faults:

1. **Four independent settlement paths, one job.** `settleOrderWithPayment` (webhook), `checkAndFixRazorpayOrder` + `checkAndFixAddingItemsOrder` (reconciliation cron), and `getRazorpayOrderStatus` self-heal (admin) each create a `Payment` and drive the `AddingItems → ArrangingPayment → PaymentSettled` transition **with different rules**. Four copies of one state machine drift apart. A fix in one reopens a gap in another. This is the "new bug every time" engine.
2. **`isPaymentWindowOpen` is a homemade shadow state machine.** One boolean, written by 3 files, gating a *destructive* `ArrangingPayment → AddingItems` revert. Razorpay already holds the truth (`order.status ∈ {created, attempted, paid}`). The shadow flag goes stale and fights Vendure's real order FSM.
3. **DB treated as money-truth.** Any design where our DB is authoritative for "did they pay?" drifts. The gateway is authoritative; our job is to *mirror* it reliably.

Plus concrete bucket-C defects (integration-side):

- **Signature verified over re-stringified JSON, not raw body** (`JSON.stringify(body)` at webhook.service.ts:412, :163, :263). Razorpay signs raw bytes; re-serialization changes key order/whitespace/unicode → HMAC mismatch → `Invalid Webhook Signature` → silent non-settlement. Industry's #1 documented Razorpay mistake.
- **Synchronous webhook processing** (controller awaits the full pipeline before returning 200) → slow handler → Razorpay retries → load amplification.
- **Dedup in Redis TTL only; raw events never persisted** → cache eviction breaks idempotency; no replay/audit.
- **`transitionToState` result ignored** (returns an error object, doesn't throw) → reconciliation logs SUCCESS on failure.
- **Paise/rupee guessing** (`amount * 100 >= total`) scattered in 4 places.

## 3. Worldwide failure taxonomy (context)

| Bucket | Examples | Our leverage |
|--------|----------|--------------|
| A. Instrument-side | wrong PIN, insufficient funds, limit, fraud decline | none (retry UX) |
| B. Network/PSP infra | bank down, UPI timeout, `payment.downtime` | none (retry + reconcile) |
| C. Integration-side | signature, ordering, idempotency, sync-timeout, lost webhook | **100%** |
| D. Money-taken/order-not-placed | captured but stranded | **100%** (C leaking) |

Webhook law: **at-least-once, never exactly-once.** Duplicates and out-of-order delivery are guaranteed. `payment.failed` (attempt-1) *will* arrive after `payment.captured` (attempt-2). The design must be idempotent and order-independent by construction.

## 4. Target architecture

Collapse four paths into **one idempotent `SettlementService`** with **Razorpay as source of truth**, fed by a **durable event log**, verified on **raw body**, drained **async** by the worker. Webhook and cron become thin callers.

```
                 ┌─────────────────────── Razorpay ───────────────────────┐
                 │  order.status: created | attempted | paid (SOURCE OF TRUTH) │
                 └──────────────┬───────────────────────────┬───────────────┘
     webhook POST (raw body)    │                           │  poll (cron fallback)
                 ▼              │                           ▼
   ┌─────────────────────────┐  │              ┌──────────────────────────────┐
   │  WebhookController        │ │              │  ReconciliationJob (worker)    │
   │  1. verify RAW-body sig   │ │              │  - stale ArrangingPayment/     │
   │  2. persist raw event ──► │ │              │    AddingItems + rzpOrderId    │
   │     RazorpayWebhookEvent  │ │              │  - enqueue settle job          │
   │  3. return 202 immediately│ │              └───────────────┬──────────────┘
   └───────────┬───────────────┘ │                              │
               │ enqueue          │                              │ enqueue
               ▼                  ▼                              ▼
        ┌────────────────────────────────────────────────────────────┐
        │              JobQueue: "razorpay-settle"                     │
        └───────────────────────────┬────────────────────────────────┘
                                     ▼
        ┌────────────────────────────────────────────────────────────┐
        │  SettlementService.reconcileOrder(ctx, rzpOrderId)   [CORE]  │
        │  - fetch Razorpay order+payments (authoritative)             │
        │  - idempotent: no-op if already PaymentSettled               │
        │  - status=paid/captured  → ensure Payment + transition Settled│
        │  - status=authorized     → transition Authorized             │
        │  - status=created/attempted (no capture) → safe to revert     │
        │  - ALL transitions: check error-result, atomic (withTransaction)│
        └────────────────────────────────────────────────────────────┘
                                     │ on stuck > N min
                                     ▼
                          ┌────────────────────┐
                          │  AlertService (push)│  WhatsApp/email to ops
                          └────────────────────┘
```

### 4.1 Single source of truth for settlement decisions

`SettlementService.reconcileOrder(ctx, rzpOrderId)` is the **only** function that mutates payment state. Decision table, keyed on Razorpay (not our flags):

| Razorpay `order.status` | Captured payment? | Vendure order state | Action |
|---|---|---|---|
| `paid` | yes | not yet settled | ensure `Payment(Settled)` → transition `PaymentSettled` |
| `paid`/any | authorized only | not settled | ensure `Payment(Authorized)` → transition `PaymentAuthorized` |
| `created`/`attempted` | no | `ArrangingPayment` stale | **safe** to revert `AddingItems` (no money) |
| any | yes | already `PaymentSettled` | **no-op** (idempotent) |
| API error / unknown | — | — | **do nothing** (never revert on uncertainty) |

`isPaymentWindowOpen` is **demoted to a UI hint only** — never gates a destructive action again.

### 4.2 Durable event log — new entity

`RazorpayWebhookEvent` (extends `VendureEntity`):

| Field | Purpose |
|---|---|
| `eventId` (unique, from `x-razorpay-event-id`) | idempotency key — DB unique constraint, not Redis TTL |
| `event` | `payment.captured`, `order.paid`, `payment.failed`, … |
| `rzpOrderId` / `rzpPaymentId` | correlation |
| `rawPayload` (text) | exact bytes for replay/audit |
| `signatureValid` (bool) | audit |
| `status` (`received`\|`processed`\|`failed`\|`ignored`) | drain state |
| `processedAt`, `error` | observability |

Idempotency becomes a DB uniqueness guarantee (survives cache eviction) and gives you replay + audit for free.

### 4.3 Controller flow (fast + safe)

1. Read **raw body** (Buffer) — via NestJS `rawBody`/bodyParser `verify` hook capturing `req.rawBody`. Signature verified over those exact bytes.
2. Verify signature (constant-time compare). Invalid → 400, log, drop.
3. `INSERT ... ON CONFLICT(eventId) DO NOTHING` into `RazorpayWebhookEvent`. Conflict = duplicate → 200, done.
4. Enqueue `razorpay-settle` job with `{ eventId }`.
5. Return **202 Accepted** immediately.

Heavy work (Razorpay API calls, transitions) moves to the worker. Webhook latency drops to a couple DB writes.

### 4.4 Worker job

`razorpay-settle` handler: load event → resolve channel ctx → `SettlementService.reconcileOrder`. On failure, Vendure JobQueue retries with backoff (durable, unlike a sync HTTP handler). Mark event `processed`/`failed`.

### 4.5 Reconciliation (settlement-grade)

Cron keeps scanning `ArrangingPayment` + `AddingItems`-with-`rzpOrderId`, but only **enqueues settle jobs** — it no longer contains its own settlement logic (that lived in 2 methods; both deleted, folded into `SettlementService`). Optional Phase-2.5: daily compare against Razorpay **settlement report** for orders we might have missed entirely.

### 4.6 Alerting

`getRazorpayAlerts` output gets a consumer: orders stuck > 15 min with a captured Razorpay payment → push to ops (reuse existing MSG91/WhatsApp path). Money-stuck should page a human, not sit silent.

## 5. Files (impact map)

**New:**
- `entities/razorpay-webhook-event.entity.ts`
- `service/razorpay-settlement.service.ts` (the CORE — absorbs all 4 paths)
- `job/razorpay-settle.job.ts` (JobQueue registration)
- `middleware/raw-body` wiring (or plugin bootstrap bodyParser verify)
- `src/migrations/<ts>-razorpay-webhook-event.ts`

**Heavily changed:**
- `service/razorpay-webhook.controller.ts` → verify-raw → persist → 202
- `service/razorpay-webhook.service.ts` → shrinks to payload parsing + event routing; settlement delegated
- `service/razorpay-reconciliation.service.ts` → enqueues jobs, deletes `checkAndFix*` bodies
- `api/resolver/admin/razorpay-admin.resolver.ts` → self-heal calls `SettlementService`
- `razorpay.plugin.ts` → register entity, job queue, providers

**Deleted logic:** duplicated transition dances in 3 files.

## 6. Migration & rollout (safe, incremental)

Do NOT big-bang. Order that keeps the site payable at every step:

1. **Raw-body signature fix** (isolated, high value). Ship + watch webhook success rate.
2. **`RazorpayWebhookEvent` entity + migration** (additive, no behavior change). Persist events in parallel with existing dedup.
3. **`SettlementService`** — extract the *correct* union of the 4 paths behind one API. Route webhook through it first (cron/self-heal still old).
4. **Switch controller to persist → 202 + worker job.** Keep sync path behind a config flag for one release; compare.
5. **Route cron + self-heal through `SettlementService`.** Delete dead code.
6. **Demote `isPaymentWindowOpen` to UI hint.** Remove it from revert gates.
7. **Alerting + settlement-file reconcile.**

Each step is independently shippable and reversible. `synchronize:false` respected — every schema change via a migration (project rule).

## 7. Risks & watch-outs

- **Raw body in NestJS/Vendure:** Vendure's middleware may already parse JSON before your controller. Must register a bodyParser `verify` that stashes `req.rawBody`, or a route-scoped raw parser for `/shop-api/razorpay/webhook` **only** (don't break other routes). Verify in a spike before step 1.
- **Razorpay rate limits:** worker settle jobs + cron both call the API. Keep the existing per-order cooldown; add a global concurrency cap on the job queue.
- **Multi-channel:** channel-scoped keys must be resolved inside the worker (no request context). Pattern already exists in reconciliation — reuse.
- **Event ordering:** `SettlementService` is order-independent by design (reads Razorpay fresh each time), so a late `payment.failed` after settle is a no-op — the class of bug that caused both incidents disappears structurally.
- **Idempotency under concurrency:** two jobs for the same order racing → rely on DB unique `transactionId` on Payment + `withTransaction` + re-check state inside the tx.

## 8. Success criteria

- Zero money-captured orders in `AddingItems`/`ArrangingPayment` > 15 min (alert if any).
- Webhook endpoint p99 < 300 ms (was multi-second).
- One settlement code path (grep: exactly one place transitions to `PaymentSettled` for Razorpay).
- Signature verification success rate ~100% for genuine Razorpay events.
- Replayable: any stranded order fixable by re-enqueuing its stored event.

## 9. The assignment (do this before writing code)

**Spike the raw-body question first — it's the one unknown that can sink the plan.** In a branch, add a bodyParser `verify` hook (or route-scoped `express.raw`) for the webhook path, log `req.rawBody` alongside `JSON.stringify(body)` for 5 real Razorpay test webhooks, and confirm the HMAC matches the raw bytes but not the re-stringified body. If raw body is reachable without breaking other routes → the whole design is green. If Vendure's pipeline makes raw body hard → we adjust step 1 before committing to the rest.

Second: pull one week of Razorpay Dashboard → **Settlements/Transactions export**, left-join against your `order` table on `razorpayOrderId`, and count how many captured payments have a non-`PaymentSettled` order. That number is your current bleed rate and your baseline for success criterion #1.
