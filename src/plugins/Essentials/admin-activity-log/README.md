# Admin Activity Log

Attributes every administrator action on the Admin API to a named person, device
and working session.

Built 2026-08-13/14. Design doc:
`~/.gstack/projects/kaaikani-Admin-ui/adminuser-rolelogs-design-20260813-165558.md`

---

## The problem it solves

Every administrator logged in with full access and nothing recorded what they
did. Products were deleted and disabled with no way to determine who, when, or
from where.

Three separate gaps, which have three different answers:

| Data | Before | After |
|---|---|---|
| Active sessions per admin | Vendure already wrote these | unchanged, now readable |
| Device identity (browser/OS/IP) | not stored at all | captured per session |
| Who deleted/disabled entity X | not stored at all | captured per action |

**This is not archaeology.** Actions taken before deployment were never recorded
and cannot be recovered. Products are soft-deleted (`deletedAt` set, row intact),
so *what* was deleted is still recoverable from the database; *who* did it is
gone permanently for anything predating the plugin.

---

## Architecture

### Why an interceptor and not EventBus

```
Admin mutation
      │
      ▼
┌─────────────────────────────────────────┐
│  APP_INTERCEPTOR  ← capture happens HERE │
└──────────────────┬──────────────────────┘
                   │
      ┌────────────┴────────────┐
      ▼                         ▼
 CORE services            THIS REPO's ~40 plugins
 ProductService           price-matrix, location-stock,
 CollectionService        postal-code, cancel-order …
      │                         │
      ▼                         ▼
  EventBus                  NOTHING
      ▲
      └── an EventBus-based audit would see only this half
```

Vendure core services publish `VendureEntityEvent` subclasses. The custom plugins
in this repo publish nothing. An event-based audit would silently miss every
price matrix save, stock update and postal code edit — with no error to reveal
the gap.

The interceptor sits above the fork, so it sees both halves. It also records
**failed** mutations and **failed logins**, which no event can express.

Precedent: Vendure core itself ships four `NestInterceptor`s
(`IdInterceptor`, `TransactionInterceptor`, `CustomFieldProcessingInterceptor`,
`TranslateErrorResultInterceptor`), so `APP_INTERCEPTOR` is a sanctioned pattern
here, not a workaround.

### Capture path

```
1. GqlExecutionContext → info.operation.operation
      bail unless 'mutation'                    ← removes ~90% of traffic
2. internal_getRequestContext(req, executionContext)
      bail unless ctx.apiType === 'admin'       ← removes all storefront traffic
3. bail if operationName ∈ IGNORED_OPERATIONS
4. capture: operationName, sanitized args, adminId, channelId, ip, sessionId
5. tap(response) → outcome SUCCESS | ERROR, errorMessage, durationMs
6. push to in-memory buffer — never awaited, never blocks the mutation
      │
      ▼  flush on 2s timer OR 200 rows, whichever first
   ONE bulk INSERT
```

A failing log must never fail a mutation. The write is fire-and-forget.

### Why it is cheap

Four levers, in order of impact:

1. **`apiType === 'admin'` filter** — storefront traffic never reaches the writer.
2. **Mutations only** — reads are roughly 20x the volume for a fraction of the signal.
3. **Buffered bulk insert** — one INSERT per 2s instead of one per mutation. A bulk
   price sync already took this server down once; the audit log must not cause
   the second time. `MAX_BUFFER_ROWS` drops with a warning rather than growing
   without bound.
4. **In-memory admin cache** — `ctx.activeUserId` is a `User` id, not an
   `Administrator` id. Resolving the name needs a lookup; the admin set is tiny
   and static, so a `Map` means zero extra queries after warmup.

---

## Data model

### `admin_activity_log`

| column | notes |
|---|---|
| `operationName` | `deleteProduct`, `setVariantChannelPrices`, `LOGIN_FAILED` |
| `entityType`, `entityId` | best-effort, derived from the mutation name and args |
| `targetCount` | blast radius — one call touching 200 variants is one row with 200 |
| `payload` | sanitized, size-capped mutation arguments |
| `changedFields` | dotted paths of what actually changed — `null` when undeterminable |
| `outcome`, `errorMessage` | `SUCCESS` / `ERROR` |
| `adminId`, `adminName` | name **snapshotted** at write time |
| `sessionId` | the Session **primary key** — never the token |
| `channelId`, `ipAddress`, `durationMs` | |
| `isAuthEvent` | true for LOGIN / LOGOUT / LOGIN_FAILED |
| `userAgent` | **not a column** — resolved at read time from the Session |

Indexes: `(entityType, entityId)`, `(adminId, createdAt)`, `(sessionId, createdAt)`,
plus singles on `operationName` and `sessionId`.

Rows are append-only. Nothing updates or locks them — locking an append-only log
table accomplishes nothing, since there is no per-key row to contend on.

**Names are snapshotted deliberately.** `adminName` is stored as a string rather
than joined at read time so the log stays readable after an administrator is
deleted. Same pattern as `PriceChangeLog` elsewhere in this repo.

### Device identity lives on `Session`, not on the log

`Session` implements `HasCustomFields`, so three custom fields carry the
fingerprint without a second table:

- `userAgent` — captured at login
- `ipAddress`
- `lastSeenAt` — throttled to at most one write per 10 minutes per session

Storing the UA once per session rather than copying ~120 bytes onto every action
row is the whole reason `sessionId` holds the Session primary key: it makes the
join possible.

**Read-side batching.** Resolving the UA per row would be a classic N+1 — a
100-row product history issuing 100 queries. `attachUserAgents` collects distinct
session ids and fetches them in a single `IN` query. Sessions repeat heavily
across rows, so the distinct set is usually one or two. Two queries total,
applied to all three read paths.

> The general shape: **normalise on write, batch on read.**

---

## Change detection

`changedFields` answers *what did they actually change*, which the payload alone
cannot.

**The problem.** The Dashboard submits the entire form on every save, not a
delta. Two consecutive `updateProduct` payloads for the same product differ in
one translation field and agree on everything else — yet both carry `enabled`,
every asset id and every translation. So the log announced "Enabled product
#731" for an edit that enabled nothing, because `input.enabled` was `true`.

**The mechanism.** `diff-payload.ts` compares each payload against the previous
recorded payload for the same entity. The comparison is structural and
entity-agnostic on purpose: one implementation covers Product, ProductVariant,
Customer, Promotion and every custom plugin without per-entity field mapping.
That is what ruled out loading each entity from the database before the mutation.

**Where it runs.** In `ActivityLogWriterService` at flush time, never in the
interceptor. The diff needs a database read, and the writer's first invariant is
that it never blocks a mutation. At flush time it costs a handful of indexed
queries per batch instead of one per mutation, chunked at `BASELINE_CHUNK_SIZE`
(50) so a bulk import cannot generate a subquery with thousands of `OR` clauses.

### Rules the diff obeys, and why

| rule | reason |
|---|---|
| Only fields present on **both** sides are compared | An omitted key means "leave this alone", not "was null". The product-stock toggle saves a two-field payload; the Update button sends the whole form. Absent-vs-present is not a change. |
| `id`, `createdAt`, `updatedAt` ignored at every level | A translation's `id` appears only after the first save creates the row, which would otherwise report three phantom changes. |
| Translations matched by `languageCode`, not position | Reordering languages is not an edit to all of them. |
| Keyless arrays reported whole (`assetIds`) | "assetIds changed" is useful; "assetIds[2] changed" is not. |
| Either side `[TRUNCATED_DEPTH]` → stay silent | Two markers are not evidence that two values are equal. |
| Either side byte-truncated → return `null` | That payload has a different shape entirely; reporting `[]` would claim "nothing changed" when the truth is "nothing determinable". |
| `null` for creates, deletes, auth events and failures | A create changes everything by definition, a delete changes none, a failure changed nothing at all. |

**`null` and `[]` mean different things** and the UI renders them differently:
`null` → say nothing; `[]` → "no fields changed".

### The depth trap

`MAX_PAYLOAD_DEPTH` was originally 4. A translated custom field sits at depth
five — `args → input → translations → item → customFields → localName` — so it
was stored as `[TRUNCATED_DEPTH]`. That lost the value **and** blinded the diff:
two different values both serialised to the same marker and compared equal, so a
real edit was reported as no change. Raised to 6. `MAX_PAYLOAD_BYTES` still
bounds the total, so the extra depth cannot run away.

---

## Security

Sanitization is not optional and is enforced in the writer, not left to callers.

- **Key denylist** (substring, case-insensitive): `password`, `token`, `secret`,
  `apikey`, `privatekey`, `authorization`, `credential`, `otp`, `pin`. So
  `newPassword` and `currentPassword` are both caught by `password`.
- **Size caps**: 8 KB payload, 512-char strings, depth 4, 20 array elements.
  The product-import mutation can carry megabytes.

Without this, `createAdministrator` arguments would write plaintext passwords
into a table any audit reader can query — a worse hole than the one being closed.

`sessionId` stores the Session **id**, never the token. The token is a live
credential.

### Permissions

Custom `PermissionDefinition`, with an explicit `Permission.SuperAdmin` fallback
on every `@Allow`:

```ts
@Allow(adminActivityLogPermission.Read, Permission.SuperAdmin)
```

The fallback is required. Without it the feature fails closed on first deploy —
nobody holds the new permission yet, including you. Precedent:
`postal-code-admin.resolver.ts:36`.

---

## GraphQL API (Admin)

| query | purpose |
|---|---|
| `adminActivityLogs(options)` | paginated, filterable, sortable list |
| `adminActivityForEntity(entityType, entityId, take)` | full history for one entity |
| `adminActivitySessions(skip, take, adminId, since)` | one row per device session |
| `adminActivitySessionTimeline(sessionId)` | ordered timeline within one session |

`AdminActivitySessionList` deliberately does **not** declare
`implements PaginatedList`. That interface requires `items: [Node!]!`, and a
session summary is an aggregate over log rows — it has no id and cannot implement
`Node`. Declaring it crashed server boot with
`Interface field PaginatedList.items expects type [Node!]!`.

Session aggregates use a raw subquery plus a separate `COUNT`, never
`getManyAndCount()`. TypeORM returns a wrong `totalItems` when the query has a
`GROUP BY` — it counts grouped rows as a scalar.

---

## Dashboard UI

Registered under **System → Admin Activity**. Dashboard only; the Angular Admin
UI has no audit view.

| route / block | what it shows |
|---|---|
| `/admin-activity` | timeline of all activity; filters for administrator, destructive, sign-ins, outcome |
| `/admin-activity/sessions` | one expandable row per administrator, device sessions nested |
| `/admin-activity/sessions/$sessionId` | working-day timeline with idle gaps |
| product detail page block | that product's history, anchored after the variants table |

The activity list and the product block share one renderer,
`ActivityTimelineEntry` in `activity-entry.tsx`, built on Vendure's own exported
`HistoryTimeline` / `HistoryEntry`. Both therefore render identically to Order
and Customer history rather than being lookalikes that drift when Vendure
restyles — and a fix to the icon rules or the payload toggle lands in both places
at once.

`HistoryTimelineWithGrouping`, which collapses runs of minor entries on the order
page, is **not** usable here: its props type `entity` as
`OrderHistoryOrderDetail | CustomerHistoryCustomerDetail`, hard-coupling a
general-purpose timeline to the two entities Vendure's own history supports.

The two-tier look comes from one prop: `timelineIcon` renders **only** when
`isPrimary` is true. Destructive and failed rows get the filled circle;
everything else gets a plain dot.

### Work Sessions groups by administrator

Ten administrators across four devices each is forty cards, which is unreadable.
The page collapses to one row per person, expanding to that person's device
sessions.

Grouping happens **in the browser**, not in SQL, and that is forced rather than
lazy: `GROUP BY adminId` with `LIMIT/OFFSET` would put one person's desktop on
page 1 and their phone on page 3. The unit of pagination has to be the
administrator, which a query paging sessions cannot deliver. The date filter
bounds the fetch instead (`take` capped at 500, scoped by `since`).

Only the date filter reaches the server. Search, device type and has-failures
narrow data already in memory — instant, and no query per keystroke. Device type
is parsed from the user agent client-side, so sessions with no captured UA are
excluded rather than guessed at.

Groups are keyed on `adminId`, falling back to the snapshotted name, so a deleted
administrator stays one row instead of scattering.

### Readability is the point

`format.ts` reads intent back out of the row rather than showing the raw mutation
name:

```
updateProduct, diff says enabled changed  →  "Disabled product #110"   amber, destructive
updateProduct, diff says description      →  "Updated product #110"
                                             "Changed: Description (English)"
deleteProduct                             →  "Deleted product #377"
```

`enabled` promotes an edit to an explicit Enable/Disable **only when the diff
confirms that field changed**. Reading it straight from the payload — the
original implementation — announced an enable on every ordinary edit, because the
form resubmits it. `isDestructive` carries the same guard, so the amber badge
stays meaningful.

Field paths are humanised for people who never see the API:
`translations.ta.customFields.localName` → **Local Name (Tamil)**.

Payload sits behind a **Payload** toggle. It is frequently hundreds of lines of
translations and custom fields, and rendering it inline drowned the timeline.

### Freshness

The entity history block polls every 10s. Invalidating the query cache on save
does **not** work: the writer buffers rows for `FLUSH_INTERVAL_MS`, so at the
moment the mutation returns the row does not exist yet and an immediate refetch
would cache the empty answer. That is the cost of batching, paid on the read
side.

---

## Retention

`activityLogPruneTask`, a Vendure `ScheduledTask`, deletes rows older than
`RETENTION_DAYS` (180) in batches of `PRUNE_BATCH_SIZE` (5,000). Without it this
becomes the largest table in the database within a year.

---

## Known limits

- **Brave is undetectable.** Brave ships a byte-for-byte Chrome user-agent as an
  anti-fingerprinting measure. Nothing in the request headers distinguishes it;
  only `navigator.brave.isBrave()` running in the page can. Read "Chrome" as
  "Chrome or Brave".
- **Background changes are invisible.** The interceptor is an `APP_INTERCEPTOR` on
  the GraphQL layer, so it only fires in the **server** process. Anything the
  **worker** does writes nothing: scheduled tasks, job-queue handlers, the
  price-sync drain, the availability sweep. If a task disables a product the log
  stays silent and a reader would conclude no administrator touched it. This is
  the same symptom the plugin exists to solve, in a path it does not cover.
- **The log can silently lose rows.** Past `MAX_BUFFER_ROWS` (2,000) rows are
  dropped. A warning goes to the application log, but nothing in the audit
  **table** records the gap, so a reader sees unbroken history. For forensics
  that is the worst failure mode: not missing data, but missing data that looks
  like nothing is missing. A synthetic gap-marker row would fix it; not built.
- **The diff's baseline is the previous *logged* payload**, not the entity's real
  prior state. The first change to an entity has nothing to compare against, and
  a change made outside the Admin API leaves the next diff measured against a
  stale baseline.
- **Batch-shared timestamps.** `createdAt` is set at INSERT time, so rows flushed
  in the same 2s batch share an identical microsecond. Ordering falls back to
  `id`, which is monotonic. Cosmetic.
- **Rows predating the session-id change** stored a token hash instead of the
  Session id and resolve no device. Rows predating `changedFields` have `null`.
- **Only mutations plus three allowlisted reads** (`exportCustomers`,
  `reportData`, `purchaseList`). Browsing is not recorded. The log answers
  "what did they change", not "what did they look at".
- **Never load-tested.** Every admin mutation now passes through an interceptor
  and every flush issues extra queries. The overhead has not been measured.

---

## Operational notes

- **Restart after any edit.** `dev:server` and `dev:worker` run under `ts-node`
  with no watch mode. Dashboard extensions are scanned at config-load, so UI
  changes also need a restart, not just HMR.
- **Migrations**: `synchronize` is `false`; schema changes go through migrations
  only. Every `migration:generate` on this repo also emits a destructive
  `DROP COLUMN description` on `product_translation` / `collection_translation` —
  **delete those statements from the generated file before running it.**
- **Deploy check**: on the pm2 box, boot failures exit 0, so pm2 reports healthy
  on a dead server. Verify the plugin actually loaded rather than trusting the
  process state or an open port.

---

## Tests

```bash
bunx vitest run --config vitest.unit.config.mts src/plugins/Essentials/admin-activity-log
```

**82 tests across four files.** Every one exists because something was wrong, not
for coverage's sake.

| file | count | what it locks down |
|---|---|---|
| `extract-target.spec.ts` | 20 | two shipped regressions in entity-type derivation |
| `sanitize-payload.spec.ts` | 18 | credential redaction and size bounds |
| `diff-payload.spec.ts` | 22 | change detection, including three bugs found in live rows |
| `format.spec.ts` | 22 | action wording, field labels, user-agent parsing |

**`extract-target`** — `settlePayment` matched the shorter verb `set` and produced
the entity type `tlePayment`. A verb now only counts when it ends on a camelCase
boundary, and the verb list is sorted longest-first.
`addFulfillmentToOrder` and `transitionFulfillmentToState` produced two
*different* `entityType` values for the same entity, silently breaking per-entity
lookup. Compound names are now cut at connector words (`To`, `For`, `From`,
`With`, `On`, `In`) — but only when followed by a capital, so `createToken` is not
mangled.

> An inconsistently-derived column is worse than a null one: null says "I don't
> know", inconsistent says nothing while looking correct.

**`sanitize-payload`** is the most important file here and had **zero** tests
until an audit caught it. It is what stops `createAdministrator` writing a
plaintext password into a table every audit reader can query. Tests cover
substring and case-insensitive key matching, whole-subtree redaction, depth,
array and string caps, circular structures and non-object arguments.

A test also documents an accidental property worth keeping: **array and string
caps fire before the byte cap**, so long lists stay diffable rather than
collapsing into a preview blob.

**`diff-payload`** uses the real stored payloads of log rows 29 and 30 as its
fixture — two consecutive `updateProduct` calls where only the English
description changed. A hand-simplified fixture would not exercise the full-form
resubmit that the whole module exists to handle.

### Not covered by unit tests

`activity-log-writer` (baseline loading, same-batch baseline promotion),
`admin-activity-log.service` (read side), the interceptor, `session-activity`,
the prune service, and `@Allow` permission enforcement. All six need a live
database or a Nest execution context, and this repo has no integration harness.
This is a gap, not an oversight.

---

## Not built

- **Alerts** — role/administrator changes, destructive velocity (>N deletes in 5
  min), new device. The event hooks exist (`RoleChangeEvent`, `AdministratorEvent`,
  `PasswordResetEvent`); only the delivery wiring is missing. These are the parts
  that *prevent* damage rather than explain it afterwards.
- **Drop-gap marker** — one synthetic row recording "N rows dropped between T1 and
  T2" whenever the buffer overflows, so a gap is visible where people actually
  look. Roughly twenty lines, and the single highest-value item left.
- **Notes** — Vendure's order history lets an operator annotate an entry
  (`HistoryNoteInput`, `HistoryNoteEntry`, `HistoryNoteEditor`, all exported). The
  log currently records *who* disabled a product but can never record *why*.
- **Role split** — deliberately deferred so real activity data informs which
  permissions each role actually needs. Logging is detective; roles are
  preventive.
- **EventBus enrichment** — would give per-entity rows for bulk mutations.
  Deferred pending evidence that the payload is too thin to read.

## Related finding (separate problem)

The `session` table is 4.5 GB / 13.9M rows because `sessionDuration` is unset
(Vendure defaults to `'1y'`) and `cleanSessionsTask` drains 1,000 rows/day
against a 13.8M backlog. Adding indexes does **not** help — the cleanup predicate
matches 99.5% of the table, so a full scan is correctly cheaper, and the query is
already 52ms because `LIMIT` exits early.

**Applied.** `src/vendure-config.ts` now calls
`cleanSessionsTask.configure({ schedule: cron => cron.every(1).hours(), params: { batchSize: 25_000 } })`
— roughly 23 days to drain. `configure()` mutates the task in place and
`defaultConfig.schedulerOptions.tasks` already holds that same singleton, so the
statement is the whole registration; pushing it into the array would register a
duplicate id.

Full analysis, measured numbers and the foreign-key proof that no other table is
affected: [`docs/session-table-cleanup.md`](../../../../docs/session-table-cleanup.md).
