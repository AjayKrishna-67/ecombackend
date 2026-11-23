# Goods Transfer — Complete Build Plan

**Status:** authority document. Code follows this; this does not follow code.
**Supersedes:** `SPEC.md`, which is marked superseded at Phase 0 and deleted at Phase 8 — once the 19 remaining `SPEC §` citations in the code have been rewritten as `GT-xx`. Deleting it earlier would leave those citations pointing at nothing, alongside the 30 that already point at the long-gone `TDS §` / `BRS §` document. Two documents means two truths; a deleted document that is still cited means no truth at all.

Every code comment in this module cites a `GT-xx` rule from §1. A comment that explains a rule instead of citing one is how the last version drifted.

---

## 1. Core Rules

| ID | Rule |
|---|---|
| **GT-01** | Source channel is a **label** — it records where goods came from. Source stock is never read and never written, at any state. |
| **GT-02** | Destination stock increases **only** on `RECEIVED`. |
| **GT-03** | Destination stock decreases **only** on damage approval. Never below zero — a deduction that would go negative is blocked with a named error. |
| **GT-04** | Entry offers products assigned to the **selected destination channel**, deleted ones excluded. **Disabled products are included** — this picker is admin-only, and "off sale" is not "does not exist". `enabled` is returned so the screen can label them. Prefix search, 25 results. |
| **GT-05** | **Only enabled products post stock on receipt.** A disabled line is received, documented and audited, but writes nothing — and says so, in the receive result, the audit entry and the source's notification. Never silent. |
| **GT-06** | States: `DRAFT → CONFIRMED → DISPATCHED → RECEIVED`. Forward only. No revert, and no cancelled state. |
| **GT-07** | Edit / remove line / delete is allowed at `DRAFT`, `CONFIRMED`, `DISPATCHED`. `RECEIVED` is closed — stock is written by then, so a change there is a stock correction (the damage flow), not a transfer edit. States never move backwards. |
| **GT-17** | **Received** requires a confirmation dialog naming the transfer — it writes stock and cannot be undone. This is a **UI concern only** (Phase 9); the server already refuses a second receive through its state assert and row lock, so nothing is built for it before the screens exist. Confirm, Dispatch and Save need no dialog — they remain editable, and a dialog on every button is a dialog nobody reads. |
| **GT-08** | `DRAFT` delete = row removed, and the transfer number is burned — never reissued. Delete from `CONFIRMED`/`DISPATCHED` is **not implemented and not requested**; a `CANCELLED` state was proposed and rejected. Do not build it without being asked. |
| **GT-09** | PDF is produced at `CONFIRMED`. Every later edit **overwrites the same asset**. One document per transfer, always current. |
| **GT-10** | Every save at `CONFIRMED`/`DISPATCHED` notifies the destination with the **diff** — what was added, removed, changed — naming the transfer number. A no-op save notifies nobody. |
| **GT-11** | Damage ≥ **5%** of a line requires a photo. Below 5% the photo is optional. |
| **GT-12** | Damage notification reaches the **source channel only**. A SuperAdmin holding a different channel token must not see it. |
| **GT-13** | **No SMS, MSG91, WhatsApp or email. Ever.** In-app notification rows only. Nothing in this module may cost money per event. |
| **GT-14** | Expiry warnings run as a `ScheduledTask`, not `setInterval`. |
| **GT-15** | Reports are channel-scoped, filter by date, search by transfer number, and show each transfer's state. |
| **GT-16** | Every action is gated by a **role permission**. `Permission.SuperAdmin` is only the usual catch-all, never the design. |

### The one rule that protects GT-01 structurally

Only `TransferStockService` may reach `StockLevelService` or `ProductStockService`. It exposes `applyReceipt` (additive only) and `deductDamage` (one line, capped, evidence-gated). Nothing else in the module can change what a branch holds.

Enforced by `services/__tests__/stock-write-boundary.spec.ts` — not by a comment, and not by a grep someone has to remember to run. It fails the build when a second file gains a reference, and names the offending file in the failure message.

The test strips comments before matching. A plain grep cannot tell an import from a comment explaining the rule, and tripped on its own prose twice while being written. It also asserts the inverse — that the permitted file really does hold the writers — so it cannot pass by scanning nothing, and it asserts that no `sourceStockLocationId` field exists. That second half matters: a field is something a future writer can aim at, and with no field there is no aim.

Verified by deliberately breaking it: adding the import to another service makes the suite fail with that file named. A guard never seen to fail is not known to work.

---

## 2. Architecture Decisions

### 2.1 Source has no stock location

There is no `sourceStockLocationId` field and no function that resolves one. A field that exists is a field someone will write to. Removing it makes GT-01 unbreakable rather than merely documented.

### 2.3 One entry query, not two

```graphql
extend type Query {
  transferDestinations(id: ID, productSearch: String): [TransferDestination!]!
}

type TransferDestination {
  id: ID!
  code: String!
  products: [TransferProduct!]!   # field resolver — resolved only when requested
}
```

- Dropdown asks for `{ id code }` — no product query runs at all.
- After the user picks: `transferDestinations(id: 5, productSearch: "rice") { products { … } }`.

Core's `channels` query cannot serve this: it requires `ReadChannel`/`ReadSettings` (`@vendure/core/dist/api/resolvers/admin/channel.resolver.js:63`), which a Transfer Manager role does not hold, and it returns the default channel and the user's own channel — neither of which is a valid destination.

### 2.4 Document numbers — exactly two

The module issues **two** human-readable numbers and no others:

| Number | Issued when | Example |
|---|---|---|
| `transferNumber` | Transfer created (`DRAFT`) | `TRF-M-0069\|26-27` |
| `damageNumber` | Damage request created | `DMG-M-0007\|26-27` |

**Removed:** `dispatchNumber` (never a requirement, never assigned, yet still read into notifications where it always resolved to `null`), the transfer's `pdfNumber`, and the damage request's `pdfNumber`. A document is titled by the number of the thing it documents — a separate number for the paper describing a transfer says nothing the transfer number did not.

Both numbers are issued at **creation**, not at approval or confirmation. A record the user can see must be nameable from the moment it exists; a number that appears later means support conversations about "the damage claim I raised yesterday" have nothing to refer to.

Both use the identical mechanism below, differing only in the group key and prefix letter.

### 2.4.1 How a number is generated

Same mechanism as invoices, no invention:

```
transfer :  groupKey = transfer:{sourceChannelId}:fy:{fy}
damage   :  groupKey = damage:{destinationChannelId}:fy:{fy}

UPDATE transfer_sequence SET lastValue = LAST_INSERT_ID(lastValue + 1) WHERE groupKey = ?
SELECT LAST_INSERT_ID()
affected = 0 → INSERT (groupKey, 1); on duplicate-key → retry the UPDATE
```

Format: `TRF-`/`DMG-` + prefix + 4-pad + `|` + FY → `TRF-M-0069|26-27`, `DMG-M-0007|26-27`.

The damage sequence keys on the **destination** channel because that is who raises the claim, mirroring the transfer sequence keying on the source that ships.

**Prefix source, and why it is not just `invoicePrefix`:** `Channel.customFields.invoicePrefix` is `nullable: true` with no default (`src/vendure-config-custom-fields.ts:203-206`). Two channels that both leave it blank would generate the identical string `TRF-0001|26-27`, and the second channel's create would fail on the unique constraint — a new branch would be unable to create transfers until someone noticed the empty field. Uniqueness must never depend on an optional value a human may leave blank.

```
prefix = invoicePrefix?.trim() || channel.code      // Channel.code is @Column({ unique: true }) in core
```

**Constraint:** `UNIQUE(sourceChannelId, transferNumber)`, not a global unique on `transferNumber`. The sequence is per-channel by construction (the group key carries `channelId`), so a global constraint asserts something the design never promised.

No new custom field is introduced.

Issued once at DRAFT creation and kept for life. Gaps are normal and correct — a burned number is evidence a transfer was cancelled.


---

## 3. Data Model

| Table | Purpose | Notes |
|---|---|---|
| `goods_transfer` | Aggregate root | `implements ChannelAware`; `channels` = [source, destination] |
| `goods_transfer_line` | Product line | pieces XOR grams; snapshots name/sku/isPooled at entry |
| `damage_request` / `_line` / `damage_photo` | GT-03, GT-11 | photo → Vendure `Asset` |
| `transfer_audit_log` | Immutable trail | written in the same transaction as the change |
| `transfer_notification` | GT-12/13 | `recipientChannelId` is the only visibility rule |
| `transfer_sequence` | GT §2.4 | `groupKey` PK + `lastValue` |

**Added:**  (§2.4), unique per destination channel.

**Removed from the current model:** `sourceStockLocationId` (0 references anywhere), `dispatchNumber` (never a requirement; read in 4 places, assigned in none, so notifications carried `null`), `DocumentKind.DispatchNumber` (0 references), both `pdfNumber` columns, and the `approvedAt`/`approvedByName` column aliases (property and column must share a name).

Local tables were truncated on 2026-08-04 and production is not deployed, so these go cleanly.

---

## 4. API Surface

The whole module, deliberately small:

| Operation | Type | Permission |
|---|---|---|
| `transferDestinations(id, productSearch)` | Query | `ReadGoodsTransfer` / `CreateGoodsTransfer` |
| `goodsTransfers(status, input)` | Query | `ReadGoodsTransfer` / `ViewTransferReports` |
| `goodsTransfer(id)` | Query | `ReadGoodsTransfer` |
| `transferNotifications(type, skip, take, unreadOnly)` | Query | `Authenticated` |
| `createGoodsTransfer(input)` | Mutation | `CreateGoodsTransfer` |
| `updateGoodsTransfer(input)` | Mutation | `UpdateGoodsTransfer` |
| `deleteGoodsTransfer(id)` | Mutation | `DeleteGoodsTransfer` |
| `confirmGoodsTransfer(id)` | Mutation | `UpdateGoodsTransfer` |
| `dispatchGoodsTransfer(id)` | Mutation | `UpdateGoodsTransfer` |
| `receiveGoodsTransfer(id)` | Mutation | `ApproveGoodsTransferReceipt` |
| `createDamageRequest(input)` | Mutation | `RecordTransferDamage` |
| `approveDamageRequest(id)` / `rejectDamageRequest(id)` | Mutation | `ApproveTransferDamage` |
| `markNotificationsRead(ids)` | Mutation | `Authenticated` |

**Net change from today: one fewer query.** `searchTransferProducts` is absorbed into `transferDestinations.products`. Photo upload uses core `createAssets`; this module only accepts `assetIds`.

---

## 5. Concurrency and Idempotency

Written per operation, because "it works when I click once" is not a specification.

| Operation | Failure it prevents | Mechanism |
|---|---|---|
| `create` | Two users, one number | Atomic `LAST_INSERT_ID` increment |
| `update` / remove line | Editing a transfer whose stock just committed | `setLock('pessimistic_write')` **before** reading state |
| `confirm` | Two PDFs, two notifications | Row lock → state assert → one transaction; PDF failure rolls back the state change |
| `dispatch` | Double notification | Row lock → state assert |
| `receive` | **Double-click adds stock twice** | Row lock → assert `DISPATCHED`; already-`RECEIVED` errors without touching stock |
| `approveDamage` | Double deduction | Row lock on the damage request → assert `PENDING_APPROVAL` |
| `cancel` | Cancelling something being received | Row lock → state assert |

Any transaction that writes stock runs: **lock → validate → write → audit → notify**, all or nothing.

---

## 6. Reference Map

Every pattern comes from outside this folder. Nothing here is invented where the project already solved it.

| Need | Source |
|---|---|
| Sequence table + atomic number | `src/plugins/Essentials/invoice-number/invoice-sequence.entity.ts`, `invoice-number.service.ts:31-113` |
| Concurrency test style | `src/plugins/Essentials/invoice-number/invoice-number.service.spec.ts` |
| Channel-aware entity | `src/plugins/Essentials/referral-rewards/entities/referral.entity.ts` |
| Assign channels on create | `src/plugins/Essentials/referral-rewards/service/referral-rewards.service.ts:104` |
| Channel-scoped list | `src/plugins/Marketing/loyalty-points/api/customer-entity.resolver.ts:26-39` |
| Channel-scoped aggregate | `src/plugins/Essentials/referral-rewards/service/referral-rewards.service.ts:453` |
| Membership guard on mutation | `src/plugins/Marketing/banner/services/custom-banner.service.ts:139` |
| Channel list | `src/plugins/Marketing/abandoned-cart/services/abandoned-cart.service.ts:128-138` |
| Enabled products of a channel | `src/plugins/Stock/location-stock/services/location-stock.service.ts:169-172` |
| Channel → StockLocation | `src/plugins/bulk-sync/bulk-sync.service.ts:296-310` |
| Piece stock write | `src/plugins/Stock/location-stock/services/location-stock.service.ts:254-267` |
| Weight-pool stock write | `src/plugins/Stock/product-stock/services/product-stock.service.ts:26-65` |
| Gram/kg conversion | `src/plugins/Stock/shared/stock-units.ts` |
| Audit row + pure builder | `src/plugins/Stock/location-stock/entities/stock-change-log.entity.ts`, `location-stock.service.ts:104-128`, `:428-452` |
| Pure-helper test style | `src/plugins/Stock/location-stock/services/__tests__/build-stock-log-rows.spec.ts` |
| Attach one Asset | `src/plugins/Marketing/offer/services/custom-offer.service.ts:177-189` |
| Attach many Assets | `src/plugins/Marketing/banner/services/custom-banner.service.ts:113-118` |
| PDF layout (pdfkit) | `static/test/generate-pdf-report.ts` |
| Permission definition | `src/plugins/Marketing/banner/permissions.ts:7` |
| Permission registration | `src/plugins/Marketing/banner/banner.plugin.ts:16-20` |
| ScheduledTask | `src/plugins/Marketing/abandoned-cart/tasks/abandoned-cart-sweep.task.ts` |
| EventBus subscribe hazard | `src/plugins/Essentials/price-update/price-update.plugin.ts:147-152` |
| Durable row + status | `src/plugins/Payment/Razorpay/entities/razorpay-webhook-event.entity.ts` |

**No external precedent exists for:** the in-app notification bell — no other plugin in this project persists notification rows. Built fresh, shaped after the nearest patterns above.

---

## 7. Build Order

Each phase ends with `bunx tsc --noEmit` clean, `bun run test` green, and a demonstration. Nothing starts until the previous phase is approved.

### Phase 0 — Ground
Documents only, no schema and no code. Mark `SPEC.md` superseded (deleted at Phase 8, see the header note). Correct `CLAUDE.md`: this project runs Vendure **3.6.3**, not 3.1.0.

Dropping the transfer tables belongs to Phase 2, not here — the entities do not change until then, and destroying the sample data before Phase 1 (which touches no database at all) would remove the only realistic fixtures available for testing the helpers.

### Phase 1 — Pure helpers
`transfer-number`, `line-diff`, `damage-percent` + `isPhotoMandatory`, `expiry`. No DB, no framework, no Nest. Each with a spec file. Damage boundary cases 4.99 / 5.00 / 5.01 are mandatory tests.
*Why first:* every rule that can be expressed as a function is tested before anything can hide it behind a database.

### Phase 2 — Entities, permissions, plugin wiring
Drop the local transfer tables first (dev data only; production is not deployed), then create the entities per §3 and let `synchronize` rebuild them clean. Permissions per GT-16, registered via `config.authOptions.customPermissions.push(...)`.

*Why the drop happens here:* removing `sourceStockLocationId`, `dispatchNumber`, `pdfNumber` and the `approvedAt` alias means `synchronize: true` alters live columns. Starting from empty tables makes that deterministic instead of dependent on what synchronize decides to do with existing data.

*Demonstration:* server boots, tables are created clean, the role's permissions appear in Settings → Roles.

### Phase 3 — Stock service, alone
`TransferStockService` only. Pieces and weight-pool paths, negative-stock block, reindex event. Channel code in error messages, never a hardcoded branch name.
*Demonstration:* the `grep` in §1 returns exactly one file.

### Phase 4 — Transfer lifecycle
Create, update, remove line, delete, confirm, dispatch, receive. Locks per §5. Audit row on every transition.

### Phase 5 — Damage
Request, photo enforcement at 5%, approve/reject, deduction through Phase 3's service only.

Also carries the numbering work deferred from Phase 2: add `damage_request.damageNumber` **together with the code that assigns it**, and remove both `pdfNumber` columns, passing the document number into `TransferPdfService` as a parameter instead. A NOT NULL column added without its writer is a row that fails to insert on the next request; the two belong in the same step.

### Phase 6 — Documents and notifications
PDF; same asset overwritten on re-confirm. Notification rows and the diff message.

### Phase 7 — Reports and expiry
Channel-scoped report with date filter and state. `ScheduledTask` replacing `setInterval`. **Verify that `ReportInput.channelIds` is validated against `ctx`** — the equivalent field in `src/plugins/Reports/service/orders-report.service.ts:1217-1222` is not, and any admin can read another channel's report through it. That bug must not be copied here.

### Phase 8 — End-to-end verification and citation cleanup
The table in §8, run against a live server with the `MAdmin` role. Then confirm no `SPEC §`, `TDS §` or `BRS §` citation remains anywhere in the folder, and delete `SPEC.md`:

```bash
grep -rn "SPEC §\|TDS §\|BRS §" --include=*.ts src/plugins/Stock/goods-transfer/   # must be empty
```

### Phase 9 — Admin UI
Separate effort, after the API is proven. Reference: `admin-ui/src/extensions/stock-manager-ui/`; for re-querying when the admin switches channel, `src/plugins/Essentials/account-deletion-request/ui/customer-deletion-widget.ts:115-125`.

Carries GT-17. The Received dialog names the transfer and its contents — "are you sure?" alone does not tell someone they are about to accept the wrong shipment:

> **Kochi stock will be updated. This cannot be undone.**
> TRF-M-0069|26-27 — 3 products.
> [ Confirm ] [ Cancel ]

The server never relies on the dialog. `receiveGoodsTransfer` keeps its own row lock and state assert, because a dialog is a client-side courtesy and the API is callable without one.

---

## 8. Acceptance Tests

Run against `http://localhost:3001/admin-api` with `bun run dev:server` (worker off).

| # | Test | Expected | Rule |
|---|---|---|---|
| 1 | Login as `MAdmin` | Token; `channels { permissions }` includes `CreateGoodsTransfer` | GT-16 |
| 2 | Any query without a token | `ForbiddenError` | GT-16 |
| 3 | `transferDestinations { id code }` | Own channel and default channel absent | §2.3 |
| 4 | `transferDestinations(id:X){ products }` | Only enabled products of X | GT-04 |
| 5 | Create with an enabled and a disabled line | Both accepted; number issued | GT-04 |
| 6 | Source stock after every state | **Unchanged throughout** | GT-01 |
| 7 | Confirm | PDF asset created; destination notified | GT-09 |
| 8 | Edit at CONFIRMED (add + remove a line) | **Same `pdfAssetId`**; diff notification naming the number | GT-09, GT-10 |
| 9 | Save with no change | No notification | GT-10 |
| 10 | Receive | Destination stock increases; pooled in grams, pieces as pieces | GT-02 |
| 11 | Receive again | Error; **stock unchanged** | §5 |
| 12 | Damage 4% without photo | Accepted | GT-11 |
| 13 | Damage 6% without photo | `UserInputError` | GT-11 |
| 14 | Damage notification, other channel token | Not visible, even to SuperAdmin | GT-12 |
| 15 | Approve damage | Destination stock decreases | GT-03 |
| 16 | Approve damage again | Error; no second deduction | §5 |
| 17 | Damage exceeding stock | Blocked, no negative | GT-03 |
| 18 | Receive a transfer holding a disabled line | Enabled line posts stock; disabled line posts none and is named in the result, the audit entry and the source notification | GT-05 |
| 19 | Next transfer after a cancel | New number; cancelled number never reused | §2.4 |
| 20 | Report with `from`/`to` | Filtered; state per transfer | GT-15 |
| 21 | Report with foreign `channelIds` | No leak | GT-12, GT-15 |
| 22 | Server log across the whole flow | Zero MSG91 / SMS calls | GT-13 |
| 23 | `grep` from §1 | Exactly one file | GT-01 |

---

## 9. Beyond v1

Ordered by value per unit of work. None of these are in scope now; the model above is built so that each can be added without reshaping it.

**1. In-transit visibility.** Today stock is at the source (untracked by this module) until receipt, then appears at the destination. Between dispatch and receipt it is invisible. A read-only "in transit" figure — derived by summing `DISPATCHED` lines, storing nothing — answers "where is my stock" without batch tracking. Highest value, lowest cost, because the data already exists.

**2. Repeat last transfer.** Branches send similar loads on a cycle. "Copy `TRF-M-0064` into a new draft" removes most of the typing and most of the entry errors. Pure UI plus one query that already exists.

**3. QR on the document.** The PDF carries a QR of the transfer id. The destination scans it and lands on the receive screen. Removes the "which transfer is this pallet" step. `qrcode` is already a project dependency — see `delivery-qr-code.service.ts`.

**4. Shortfall separated from damage.** Right now anything missing is claimed as damage. "Sent 100, arrived 95, none broken" is a different business event with a different owner. Same request shape, one extra reason field — but only once the branches ask for it, because a reason field nobody fills is noise.

**5. Reconciliation report.** Per branch per month: dispatched, received, damaged, cancelled, and the gaps between them. Turns the audit log into a management view. Everything needed is already recorded.

**6. Web push over the notification table.** The table is already the source of truth; push is a delivery layer on top. Note GT-13 — push is free, and must stay free. No SMS fallback, ever.

**7. Value on the transfer.** Attaching cost price makes inter-branch movement visible to finance. Deliberately deferred: it drags in valuation policy (which cost? at dispatch or receipt?) that is a finance decision, not an inventory one.

**8. Batch / lot tracking.** The honest fix for exact expiry. Vendure pools stock and has no batches, so this is a module, not a feature. The expiry indicator is the accepted substitute until someone is willing to fund it.

**9. Second approval above a threshold.** High-value transfers requiring a second person is a control most warehouses eventually want. Trivial once permissions are already per-role — one extra state, one extra permission. Do not build it before someone asks.
