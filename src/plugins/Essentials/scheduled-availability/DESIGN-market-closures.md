# Design — brand market closures for the purchase list report

Status: approved 2026-08-12, not yet built.
Scope: `scheduled-availability` plugin, REPORT rules only.

## The problem

The market is shut every Friday, so no purchasing happens that day. Festivals and
ad-hoc shutdowns close it on other dates too. Today a purchase list report covers
exactly one day — `TODAY` or `YESTERDAY` — so the orders placed on a closed day are
never bought against. They need to appear on the next open day's list, alongside
that day's own orders.

Concretely, for the daily Coimbatore rule covering today's orders:

- Thursday: report covers Thursday. Unchanged.
- Friday: market shut. Nothing should be sent.
- Saturday: report must cover **Friday and Saturday together**.

## Decisions taken

| Decision | Choice | Why |
| --- | --- | --- |
| Closure pattern | Recurring weekday + ad-hoc dates | Friday is weekly; festivals are not |
| Behaviour on a closed day | Send nothing, record the run | Not buying, so a list is noise; the record keeps it visible |
| Calendar scope | Per brand (Vendure `Seller`) | One Kaaikani entry covers all six of its city channels |
| Storage | SettingsStore field | No entity, no migration, and the core Settings Store page edits it |
| Run status for a closure | New `CLOSED` status | See "Why not reuse SKIPPED" below |
| Brand for a rule | Seller of the rule's own channel | Deterministic; matches how the rule is already channel-owned |

Rejected: a dedicated closure entity with a CRUD admin page. It would have to be
built twice — React Dashboard and Angular admin — for data that is a handful of
dates per brand.

Also rejected: an extra `YESTERDAY_AND_TODAY` covering mode with no calendar. It
is nearly free to build, but every festival then means hand-editing crons across
six cities, and forgetting produces a report that is silently missing a day's
orders while looking completely normal.

## Data model

One SettingsStore field, `marketClosure.config`, scoped by brand:

```json
{
  "closedWeekdays": [5],
  "closedDates": ["2026-08-15", "2026-10-20"]
}
```

- `closedWeekdays` — day numbers, 0 = Sunday through 6 = Saturday. Friday is 5.
- `closedDates` — `YYYY-MM-DD`, interpreted in the rule's timezone, not the
  server's. One-off closures only; recurring ones belong in `closedWeekdays`.

Both default to empty, which means "never closed" and preserves today's behaviour
for every existing rule.

The scope function resolves the active channel's `sellerId`. Vendure accepts an
arbitrary `({ ctx }) => string` scope function, so no custom storage layer is
needed. Confirm at build time that `sellerId` is populated on `ctx.channel`
without an extra relation load; if it is not, resolve it once and cache per run
rather than per report row.

Requires a permission for read/write, following the pattern the abandoned-cart
plugin already uses for its settings field.

## The window rule

Two distinct days are involved, and conflating them is the main trap:

- **run day** — when the cron fires.
- **target day** — whose orders the report lists. `Covering` sets the offset
  between the two: `TODAY` = 0, `YESTERDAY` = 1.

The rule, applied to every REPORT run:

1. If the **run day** is closed, send nothing. Record the run as `CLOSED`.
2. Otherwise let `k` be the number of consecutive closed days immediately before
   the run day.
3. The report window is `from = target − k`, `to = target`, each expanded to the
   full day in the rule's timezone.

`k` is capped at 7 days. A longer stretch means the calendar is misconfigured or
the worker has been down for a week; silently pulling a month of orders into one
purchase list is worse than under-reporting, and the cap keeps a mistake cheap.

### Worked examples

Friday closed, daily rule, `Covering = Today's orders` (offset 0):

```
Thu   run     k=0    covers [Thu ── Thu]
Fri   closed  —      nothing sent, run recorded as CLOSED
Sat   run     k=1    covers [Fri ─────── Sat]
```

Same calendar, `Covering = Yesterday's orders` (offset 1):

```
Fri   closed  —      nothing sent; the Thursday orders it would have carried are not lost
Sat   run     k=1    target = Fri, covers [Thu ─────── Fri]
```

The second case needs no separate code path. It falls out of the same formula,
and it correctly picks up the Thursday orders that Friday's skipped run would
have delivered.

Festival on Saturday adjacent to the weekly Friday closure:

```
Fri   closed  —
Sat   closed  —
Sun   run     k=2    covers [Fri ─────────────── Sun]
```

### Timezone

Every date question — what day is it, is that day closed, where does the day
start and end — is resolved in the rule's own timezone. `resolveReportWindow`
already does this and explains why: a 05:00 Asia/Kolkata run happens at 23:30 UTC
the previous day, so a server-clock answer is not merely wrong, it is *plausibly*
wrong and therefore hard to catch.

### Known limitation

`k` counts closed days, not gaps in the cron. A rule firing only on Monday and
Thursday will not backfill Tuesday and Wednesday, because that gap is the cron's
intent rather than a closure. All current report rules are daily, so this does
not bite today. Revisit if a weekly purchase rule is ever created.

## Skip path

A run whose run day is closed is recorded with the new status `CLOSED` and a note
naming the reason (weekly closure, or the specific dated closure that matched).
It appears in run history like any other run.

### Why not reuse SKIPPED

`SKIPPED` currently means the run came due outside its grace window — an
operational fault, usually a worker that was down. A market closure is routine.
The badge map in `dashboard/format.ts` already argues the general case: every
status keeps its own weight, and collapsing them destroys the signal. Merging the
two would bury genuine worker faults inside a weekly crowd of normal closures.

Touch points for the new status: the `AvailabilityRunStatus` union in
`constants.ts`, the badge map in `dashboard/format.ts`, the equivalent in
`ui/format.ts` for the Angular list, and the GraphQL enum if the status is typed
there rather than as a string.

## UI

**Required: none.** The core Settings Store page in the Dashboard edits the field
as soon as it is declared. The abandoned-cart plugin ships a settings field with
no dashboard folder at all, which is the precedent.

**Optional polish, in priority order:**

1. A closure form — weekday checkboxes plus an add/remove date list — following
   the block pattern in the `cancel-order` plugin's dashboard folder.
2. A line in the schedule detail's "What will happen" preview marking which of
   the upcoming occurrences will be skipped as closed, so the effect of the
   calendar is visible before it happens rather than only afterwards.

## Testing

The window logic is a pure function of (run day, offset, calendar, timezone), so
the core needs no server. Add to the existing `services/__tests__` folder:

- Offset 0 across Thu / Fri / Sat with Friday closed — the three cases above.
- Offset 1 across the same days, asserting the Thursday orders are covered.
- Chained closures, asserting `k = 2`.
- The 7-day cap, asserting the window stops growing.
- A run near midnight in Asia/Kolkata, asserting the day boundary is the rule's
  and not the server's.
- An empty calendar, asserting byte-identical behaviour to today.

## Out of scope

- Availability (non-report) rules. Closures do not affect enable/disable rules.
- Per-channel overrides within a brand. If Kochi ever closes on a different day
  from Coimbatore, this design needs a second scope level.
- Any change to how the purchase list itself is rendered. `renderPurchaseListPdf`
  already accepts an arbitrary `from`/`to` range, which is what makes this design
  cheap; nothing downstream assumes a single day.
