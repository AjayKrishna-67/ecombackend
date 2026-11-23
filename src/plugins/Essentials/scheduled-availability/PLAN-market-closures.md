# Brand Market Closures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commits:** this repo's owner commits manually. Treat every "Commit" step as a
> checkpoint — stage the files, show the diff, and ask before running `git commit`.

**Goal:** When a brand's market is shut on a given day, send no purchase list that day and roll those orders into the next open day's report.

**Architecture:** A per-brand closure calendar lives in Vendure's SettingsStore, scoped by the active channel's `sellerId`. A pure decision module answers "is this day closed" and "how many closed days precede it". The report sender turns that into a widened `from`/`to` window; the run path turns a closed run day into a new `CLOSED` run status instead of a WhatsApp send.

**Tech Stack:** Vendure 3.6.3, TypeScript, NestJS, Vitest (`vitest.unit.config.mts`), React Dashboard + Angular admin UI.

**Spec:** `src/plugins/Essentials/scheduled-availability/DESIGN-market-closures.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `functions/market-closure.ts` (create) | Pure calendar logic: config shape, is-a-day-closed, count preceding closed days, ISO date shifting. No Vendure imports. |
| `functions/market-closure.spec.ts` (create) | Tests for the above. |
| `services/report-sender.service.ts` (modify) | New closure-aware window resolver; reuses the extracted date helpers. |
| `services/__tests__/resolve-report-window.spec.ts` (modify) | Add closure-aware window cases; existing cases stay as the regression guard. |
| `constants.ts` (modify) | Settings key, `CLOSED` run status. |
| `api/api-extensions.ts` (modify) | `CLOSED` added to the `AvailabilityRunStatus` GraphQL enum. |
| `dashboard/format.ts` (modify) | Badge metadata for `CLOSED` (React). |
| `ui/format.ts` (modify) | Label and colour for `CLOSED` (Angular). |
| `scheduled-availability.plugin.ts` (modify) | Registers the brand-scoped settings field. |
| `services/availability-schedule.service.ts` (modify) | Reads the calendar, skips closed run days. |

`functions/` already holds `compute-occurrences.ts` and `decide-run-disposition.ts` — pure helpers with their spec beside them, consumed by the run path. `market-closure.ts` follows that shape exactly.

---

### Task 1: Closure calendar pure logic

**Files:**
- Create: `src/plugins/Essentials/scheduled-availability/functions/market-closure.ts`
- Test: `src/plugins/Essentials/scheduled-availability/functions/market-closure.spec.ts`

Reference dates used throughout: **2026-08-13 is a Thursday, 2026-08-14 a Friday, 2026-08-15 a Saturday, 2026-08-16 a Sunday.**

- [ ] **Step 1: Write the failing test**

Create `src/plugins/Essentials/scheduled-availability/functions/market-closure.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    countClosedDaysBefore,
    isClosedDay,
    MarketClosureConfig,
    MAX_CLOSURE_WALK_BACK_DAYS,
    shiftIsoDate,
} from './market-closure';

/** Friday-only calendar: the standing weekly market closure. */
const fridayClosed: MarketClosureConfig = { closedWeekdays: [5], closedDates: [] };

describe('shiftIsoDate', () => {
    it('moves forwards and backwards', () => {
        expect(shiftIsoDate('2026-08-15', -1)).toBe('2026-08-14');
        expect(shiftIsoDate('2026-08-15', 1)).toBe('2026-08-16');
    });

    it('crosses a month boundary', () => {
        expect(shiftIsoDate('2026-09-01', -1)).toBe('2026-08-31');
    });
});

describe('isClosedDay', () => {
    it('matches a closed weekday', () => {
        expect(isClosedDay('2026-08-14', fridayClosed)).toBe(true);
    });

    it('leaves other weekdays open', () => {
        expect(isClosedDay('2026-08-13', fridayClosed)).toBe(false);
        expect(isClosedDay('2026-08-15', fridayClosed)).toBe(false);
    });

    it('matches an ad-hoc closed date', () => {
        const config: MarketClosureConfig = { closedWeekdays: [], closedDates: ['2026-08-15'] };
        expect(isClosedDay('2026-08-15', config)).toBe(true);
        expect(isClosedDay('2026-08-16', config)).toBe(false);
    });

    // An empty calendar must behave exactly as the plugin did before closures
    // existed. Every pre-existing rule ships with this config.
    it('treats an empty calendar as never closed', () => {
        const empty: MarketClosureConfig = { closedWeekdays: [], closedDates: [] };
        expect(isClosedDay('2026-08-14', empty)).toBe(false);
    });
});

describe('countClosedDaysBefore', () => {
    it('is zero when the preceding day is open', () => {
        expect(countClosedDaysBefore('2026-08-14', fridayClosed)).toBe(0);
    });

    it('counts a single closed day', () => {
        expect(countClosedDaysBefore('2026-08-15', fridayClosed)).toBe(1);
    });

    it('chains consecutive closures', () => {
        const config: MarketClosureConfig = { closedWeekdays: [5], closedDates: ['2026-08-15'] };
        expect(countClosedDaysBefore('2026-08-16', config)).toBe(2);
    });

    it('stops at the cap when every day is closed', () => {
        const allClosed: MarketClosureConfig = { closedWeekdays: [0, 1, 2, 3, 4, 5, 6], closedDates: [] };
        expect(countClosedDaysBefore('2026-08-16', allClosed)).toBe(MAX_CLOSURE_WALK_BACK_DAYS);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- market-closure`
Expected: FAIL — `Failed to resolve import "./market-closure"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/plugins/Essentials/scheduled-availability/functions/market-closure.ts`:

```ts
/**
 * A brand's market closure calendar.
 *
 * Closures are a fact about the world that many report rules read, which is why
 * this lives in the SettingsStore per brand rather than on each rule: one write,
 * many readers, and no copies to drift apart.
 */
export interface MarketClosureConfig {
    /** Day numbers, 0 = Sunday through 6 = Saturday. Friday is 5. */
    closedWeekdays: number[];
    /** One-off closures as YYYY-MM-DD, read in the rule's timezone. */
    closedDates: string[];
}

/** Never closed -- the behaviour every rule had before this feature existed. */
export const DEFAULT_MARKET_CLOSURE_CONFIG: MarketClosureConfig = {
    closedWeekdays: [],
    closedDates: [],
};

/**
 * A longer stretch of closures than this means the calendar is misconfigured or
 * the worker has been down for a week. Silently pulling a month of orders into
 * one purchase list is worse than under-reporting, so the walk-back stops here.
 */
export const MAX_CLOSURE_WALK_BACK_DAYS = 7;

/**
 * Shifts a YYYY-MM-DD string by whole days.
 *
 * Parsed as UTC on purpose: the string already carries the date as read in the
 * rule's zone, so re-applying an offset here would shift it a second time.
 */
export function shiftIsoDate(isoDate: string, days: number): string {
    const date = new Date(`${isoDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

/** Whether the market is shut on the given day, by weekday rule or by date. */
export function isClosedDay(isoDate: string, config: MarketClosureConfig): boolean {
    if (config.closedDates.includes(isoDate)) {
        return true;
    }
    const weekday = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
    return config.closedWeekdays.includes(weekday);
}

/**
 * How many consecutive closed days sit immediately before `isoDate`.
 *
 * This is the count of runs that did not send, which is exactly how far back the
 * next open day's window has to reach to pick up their orders.
 */
export function countClosedDaysBefore(
    isoDate: string,
    config: MarketClosureConfig,
    cap: number = MAX_CLOSURE_WALK_BACK_DAYS,
): number {
    let count = 0;
    let cursor = shiftIsoDate(isoDate, -1);
    while (count < cap && isClosedDay(cursor, config)) {
        count += 1;
        cursor = shiftIsoDate(cursor, -1);
    }
    return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- market-closure`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit** (checkpoint — ask first)

```bash
git add src/plugins/Essentials/scheduled-availability/functions/market-closure.ts \
        src/plugins/Essentials/scheduled-availability/functions/market-closure.spec.ts
git commit -m "feat(scheduled-availability): add market closure calendar logic"
```

---

### Task 2: Closure-aware report window

**Files:**
- Modify: `src/plugins/Essentials/scheduled-availability/services/report-sender.service.ts:327-394`
- Test: `src/plugins/Essentials/scheduled-availability/services/__tests__/resolve-report-window.spec.ts`

`resolveReportWindow` stays exactly as it is and keeps its tests — those are the
regression guard proving an empty calendar changes nothing. The new function sits
beside it.

- [ ] **Step 1: Write the failing test**

Append to `src/plugins/Essentials/scheduled-availability/services/__tests__/resolve-report-window.spec.ts`:

```ts
import { MarketClosureConfig } from '../../functions/market-closure';
import { resolveClosureAwareWindow } from '../report-sender.service';

/**
 * The Friday market closure. These assertions are the whole feature: what the
 * Saturday purchase list must cover so that Friday's orders are actually bought.
 */
describe('resolveClosureAwareWindow', () => {
    const fridayClosed: MarketClosureConfig = { closedWeekdays: [5], closedDates: [] };
    const empty: MarketClosureConfig = { closedWeekdays: [], closedDates: [] };
    // 06:05 UTC is 11:35 Asia/Kolkata -- the real send time of the Coimbatore rule.
    const at = (isoDate: string) => new Date(`${isoDate}T06:05:00.000Z`);

    it('covers only today when nothing is closed', () => {
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', fridayClosed, at('2026-08-13'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        expect(result.from.toISOString()).toBe('2026-08-12T18:30:00.000Z');
        expect(result.to.toISOString()).toBe('2026-08-13T18:29:59.999Z');
    });

    it('reports the run day as closed on a Friday', () => {
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', fridayClosed, at('2026-08-14'));
        expect(result.closed).toBe(true);
        if (!result.closed) return;
        expect(result.reason).toContain('2026-08-14');
    });

    it('covers Friday and Saturday together on the Saturday run', () => {
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', fridayClosed, at('2026-08-15'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        // Friday 00:00 IST through Saturday 23:59:59.999 IST.
        expect(result.from.toISOString()).toBe('2026-08-13T18:30:00.000Z');
        expect(result.to.toISOString()).toBe('2026-08-15T18:29:59.999Z');
    });

    // Offset 1 needs no separate code path: the same formula picks up the
    // Thursday orders that Friday's skipped run would have carried.
    it('covers Thursday and Friday on a Saturday YESTERDAY run', () => {
        const result = resolveClosureAwareWindow('YESTERDAY', 'Asia/Kolkata', fridayClosed, at('2026-08-15'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        expect(result.from.toISOString()).toBe('2026-08-12T18:30:00.000Z');
        expect(result.to.toISOString()).toBe('2026-08-14T18:29:59.999Z');
    });

    it('chains a festival next to the weekly closure', () => {
        const config: MarketClosureConfig = { closedWeekdays: [5], closedDates: ['2026-08-15'] };
        const result = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', config, at('2026-08-16'));
        expect(result.closed).toBe(false);
        if (result.closed) return;
        expect(result.from.toISOString()).toBe('2026-08-13T18:30:00.000Z');
    });

    // An untouched calendar must produce byte-identical windows to today's code.
    it('matches resolveReportWindow exactly when the calendar is empty', () => {
        const now = at('2026-08-15');
        const closureAware = resolveClosureAwareWindow('TODAY', 'Asia/Kolkata', empty, now);
        const original = resolveReportWindow('TODAY', 'Asia/Kolkata', now);
        expect(closureAware.closed).toBe(false);
        if (closureAware.closed) return;
        expect(closureAware.from.toISOString()).toBe(original.from.toISOString());
        expect(closureAware.to.toISOString()).toBe(original.to.toISOString());
    });

    // A run just after midnight IST is still the previous day in UTC. Asking the
    // server clock which weekday it is gives a wrong-but-plausible answer.
    it('decides the run day in the rule zone, not UTC', () => {
        // 19:00 UTC on Thursday is 00:30 Friday in Asia/Kolkata -- closed.
        const result = resolveClosureAwareWindow(
            'TODAY',
            'Asia/Kolkata',
            fridayClosed,
            new Date('2026-08-13T19:00:00.000Z'),
        );
        expect(result.closed).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- resolve-report-window`
Expected: FAIL — `resolveClosureAwareWindow is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/plugins/Essentials/scheduled-availability/services/report-sender.service.ts`, add to the imports at the top of the file:

```ts
import {
    countClosedDaysBefore,
    isClosedDay,
    MarketClosureConfig,
    shiftIsoDate,
} from '../functions/market-closure';
```

Replace the private `shiftDays` helper at lines 380-384 (it duplicates `shiftIsoDate`) and update `resolveReportWindow` to use the shared helpers. The replacement for lines 327-347 plus the new function:

```ts
export function resolveReportWindow(
    mode: ReportDateRangeMode,
    timeZone: string,
    now: Date = new Date(),
): { from: Date; to: Date } {
    const today = dateInZone(now, timeZone);
    const target = mode === 'YESTERDAY' ? shiftIsoDate(today, -1) : today;
    const offset = zoneOffset(now, timeZone);
    return {
        from: new Date(`${target}T00:00:00.000${offset}`),
        to: new Date(`${target}T23:59:59.999${offset}`),
    };
}

/** Either the market was shut on the run day, or here is the window to report. */
export type ClosureAwareWindow =
    | { closed: true; reason: string }
    | { closed: false; from: Date; to: Date };

/**
 * The report window once the brand's closure calendar is taken into account.
 *
 * Two different days are in play and conflating them is the trap: the RUN day is
 * when the cron fires, the TARGET day is whose orders get listed, and `mode` is
 * the offset between them. A closed run day means no purchasing happened, so
 * nothing is sent. An open run day widens its window backwards by the number of
 * runs the closures swallowed -- which is why one formula serves both modes.
 */
export function resolveClosureAwareWindow(
    mode: ReportDateRangeMode,
    timeZone: string,
    config: MarketClosureConfig,
    now: Date = new Date(),
): ClosureAwareWindow {
    const runDay = dateInZone(now, timeZone);
    if (isClosedDay(runDay, config)) {
        return { closed: true, reason: `Market closed on ${runDay}; no purchase list sent.` };
    }
    const target = mode === 'YESTERDAY' ? shiftIsoDate(runDay, -1) : runDay;
    const missedRuns = countClosedDaysBefore(runDay, config);
    const start = shiftIsoDate(target, -missedRuns);
    const offset = zoneOffset(now, timeZone);
    return {
        closed: false,
        from: new Date(`${start}T00:00:00.000${offset}`),
        to: new Date(`${target}T23:59:59.999${offset}`),
    };
}

/**
 * The calendar date in the given zone.
 *
 * en-CA formats as YYYY-MM-DD, which is the only locale that gives a sortable
 * date without hand-assembling parts.
 */
export function dateInZone(at: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(at);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- resolve-report-window`
Expected: PASS. The pre-existing `resolveReportWindow` and `timeOfDayInZone` tests must all still pass — they are the proof the refactor changed no behaviour.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit** (checkpoint — ask first)

```bash
git add src/plugins/Essentials/scheduled-availability/services/report-sender.service.ts \
        src/plugins/Essentials/scheduled-availability/services/__tests__/resolve-report-window.spec.ts
git commit -m "feat(scheduled-availability): resolve report window against closure calendar"
```

---

### Task 3: `CLOSED` run status

**Files:**
- Modify: `src/plugins/Essentials/scheduled-availability/constants.ts:41-55`
- Modify: `src/plugins/Essentials/scheduled-availability/api/api-extensions.ts:46`
- Modify: `src/plugins/Essentials/scheduled-availability/dashboard/format.ts:172-196`
- Modify: `src/plugins/Essentials/scheduled-availability/ui/format.ts:191-224`

No test: these are declarations and display strings with no branching logic. Task 5 exercises the status end to end.

- [ ] **Step 1: Add the status to the union**

In `constants.ts`, replace the doc comment and union at lines 41-55:

```ts
/**
 * Lifecycle of a single materialised occurrence.
 * NOOP      - the target was already in the wanted state, so nothing was written.
 * SKIPPED   - claimed but past the grace window, so deliberately not applied.
 * CLOSED    - the brand's market was shut on the run day, so no report was sent.
 * CANCELLED - the parent rule was paused or edited before this run came due.
 *
 * CLOSED is deliberately not folded into SKIPPED. SKIPPED means the worker missed
 * its window -- an operational fault. CLOSED is routine and happens weekly, so
 * merging them would bury real faults inside a crowd of normal ones.
 */

export type AvailabilityRunStatus =
    | 'PENDING'
    | 'RUNNING'
    | 'DONE'
    | 'NOOP'
    | 'FAILED'
    | 'SKIPPED'
    | 'CLOSED'
    | 'CANCELLED';
```

- [ ] **Step 2: Add the value to the GraphQL enum**

In `api/api-extensions.ts`, add `CLOSED` to the `AvailabilityRunStatus` enum block at line 46, keeping the same member order as the TypeScript union (after `SKIPPED`, before `CANCELLED`).

- [ ] **Step 3: Add the React badge**

In `dashboard/format.ts`, add to `RUN_STATUS_META` after the `SKIPPED` entry:

```ts
    CLOSED: {
        label: 'Market closed',
        variant: 'secondary',
        hint: 'The market was shut on this day, so no purchase list was sent.',
    },
```

Note: `variant: 'secondary'`, not `'warning'`. A weekly closure is routine, and colouring it as a warning is exactly the signal-destroying collapse the comment above that map warns about.

- [ ] **Step 4: Add the Angular label**

In `ui/format.ts`, add a case to `runStatusLabel` before `default`:

```ts
        case 'CLOSED':
            return 'Market closed';
```

Leave `runStatusColor` alone — falling through to `undefined` gives the neutral chip, which is what routine deserves.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no output. If `RUN_STATUS_META` errors as missing a key, the union and the map have drifted — that `Record<AvailabilityRunStatus, RunStatusMeta>` type is doing its job.

- [ ] **Step 6: Commit** (checkpoint — ask first)

```bash
git add src/plugins/Essentials/scheduled-availability/constants.ts \
        src/plugins/Essentials/scheduled-availability/api/api-extensions.ts \
        src/plugins/Essentials/scheduled-availability/dashboard/format.ts \
        src/plugins/Essentials/scheduled-availability/ui/format.ts
git commit -m "feat(scheduled-availability): add CLOSED run status"
```

---

### Task 4: Register the brand-scoped settings field

**Files:**
- Modify: `src/plugins/Essentials/scheduled-availability/constants.ts`
- Modify: `src/plugins/Essentials/scheduled-availability/scheduled-availability.plugin.ts:44-47`

- [ ] **Step 1: Add the settings key constant**

In `constants.ts`, add near the other exported constants:

```ts
/** SettingsStore key for a brand's market closure calendar. */
export const MARKET_CLOSURE_SETTING_KEY = 'marketClosure.config';
```

- [ ] **Step 2: Register the field with a brand scope**

In `scheduled-availability.plugin.ts`, add to the imports:

```ts
import { Permission, SettingsStoreScopeFunction } from '@vendure/core';

import { MARKET_CLOSURE_SETTING_KEY } from './constants';
```

Above the `@VendurePlugin` decorator, add the scope function:

```ts
/**
 * Closures are a property of the brand, not the city: one Kaaikani entry covers
 * Madurai, Salem, Coimbatore, Trichy, Kochi and Coimbatore zone 2.
 *
 * `sellerId` is optional on Channel, so an unassigned channel falls back to a
 * single shared bucket rather than throwing. That bucket is harmless -- it starts
 * empty, and an empty calendar means "never closed".
 */
const brandScope: SettingsStoreScopeFunction = ({ ctx }) => String(ctx.channel?.sellerId ?? '');
```

Then extend the existing `configuration` function (currently lines 44-47) so it registers the field alongside the tasks it already pushes:

```ts
    configuration: config => {
        config.schedulerOptions.tasks.push(availabilitySweepTask, reportPruneTask);
        config.settingsStoreFields = config.settingsStoreFields ?? {};
        config.settingsStoreFields.marketClosure = [
            {
                name: 'config',
                scope: brandScope,
                requiresPermission: { read: Permission.SuperAdmin, write: Permission.SuperAdmin },
            },
        ];
        return config;
    },
```

`Permission.SuperAdmin` matches every resolver in this plugin — see the comment at `api/availability-schedule-admin.resolver.ts:23`.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 4: Restart the server and confirm the field appears**

Run: restart `dev:server` (ts-node, no hot reload — a stale process serves the old config).
Then open the Dashboard → System → Settings Store and confirm a `marketClosure.config` entry is listed and editable.

- [ ] **Step 5: Commit** (checkpoint — ask first)

```bash
git add src/plugins/Essentials/scheduled-availability/constants.ts \
        src/plugins/Essentials/scheduled-availability/scheduled-availability.plugin.ts
git commit -m "feat(scheduled-availability): register brand-scoped closure calendar setting"
```

---

### Task 5: Wire the calendar into the run path

**Files:**
- Modify: `src/plugins/Essentials/scheduled-availability/services/report-sender.service.ts:34-62, 75-92, 162-184`
- Modify: `src/plugins/Essentials/scheduled-availability/services/availability-schedule.service.ts:462-476`

- [ ] **Step 1: Accept a calendar in the sender and check it once, up front**

The window must be resolved in exactly one place. `sendReport` (line 75) is the
public entry; `resolveDocument` (line 162) is the private renderer that currently
calls `resolveReportWindow` itself at line 184. Leaving that call there would
compute the window twice and let the two drift.

In `report-sender.service.ts`, add to `SendReportArgs` (line 34):

```ts
    closureConfig: MarketClosureConfig;
```

Add a closed result type beside `SendReportResult` (line 46):

```ts
/** Returned instead of a send when the brand's market was shut on the run day. */
export interface ReportClosedResult {
    closed: true;
    reason: string;
}
```

Change `sendReport`'s return type to `Promise<SendReportResult | ReportClosedResult>`, and insert the check immediately after the recipients guard (after line 90), before any rendering or MSG91 call:

```ts
        const window = resolveClosureAwareWindow(
            args.dateRangeMode,
            args.timezone,
            args.closureConfig,
        );
        if (window.closed) {
            return { closed: true, reason: window.reason };
        }
```

Then change line 92 to pass the resolved window down:

```ts
        const { documentUrl, filename, note } = await this.resolveDocument(args, window);
```

Change `resolveDocument`'s signature (line 162) to take a second parameter
`window: { from: Date; to: Date }`, and delete its own `resolveReportWindow` call
at line 184, replacing it with:

```ts
        const { from, to } = window;
```

A union return rather than an optional flag is deliberate: an optional field lets
the caller forget to check, and forgetting here means a purchase list goes out on
a day nobody is buying.

- [ ] **Step 2: Read the calendar and skip in the run path**

In `availability-schedule.service.ts`, inject the settings store into the constructor:

```ts
        private settingsStore: SettingsStoreService,
```

adding `SettingsStoreService` to the `@vendure/core` import list, plus:

```ts
import { DEFAULT_MARKET_CLOSURE_CONFIG, MarketClosureConfig } from '../functions/market-closure';
import { MARKET_CLOSURE_SETTING_KEY } from '../constants';
```

Then replace the `REPORT` branch (currently lines 462-476) with:

```ts
            if (run.schedule.kind === 'REPORT') {
                // Read through channelCtx, not ctx: the scope function resolves the
                // brand from the ACTIVE channel, and ctx here belongs to the sweep,
                // not to the rule's channel.
                const stored = (await this.settingsStore.get(
                    MARKET_CLOSURE_SETTING_KEY,
                    channelCtx,
                )) as Partial<MarketClosureConfig> | undefined;
                const closureConfig: MarketClosureConfig = {
                    ...DEFAULT_MARKET_CLOSURE_CONFIG,
                    ...(stored ?? {}),
                };
                const sendResult = await this.reportSender.sendReport({
                    // `channel` is the Channel entity here, not its token.
                    channelToken: run.schedule.channel.token,
                    reportType: run.schedule.reportType!,
                    dateRangeMode: run.schedule.dateRangeMode!,
                    reportChannelIds: run.schedule.reportChannelIds ?? [],
                    recipients: run.schedule.recipients ?? [],
                    timezone: run.schedule.timezone,
                    closureConfig,
                });
                if ('closed' in sendResult && sendResult.closed) {
                    await this.finishRun(ctx, run.id, {
                        status: 'CLOSED',
                        note: sendResult.reason,
                    });
                    return;
                }
                await this.finishRun(ctx, run.id, {
                    status: 'DONE',
                    note: `Sent to ${sendResult.recipientCount} recipient(s). ${sendResult.note}`,
                });
                return;
            }
```

The spread over `DEFAULT_MARKET_CLOSURE_CONFIG` backfills missing keys, so a calendar saved before a future field is added does not arrive with `undefined` arrays — the same defensive merge `AbandonedCartService.readConfig` uses.

- [ ] **Step 3: Run the whole suite**

Run: `bun run test`
Expected: PASS. Existing `availability-schedule.service.spec.ts` cases construct `sendReport` args — if they fail on the new required `closureConfig`, add `closureConfig: DEFAULT_MARKET_CLOSURE_CONFIG` to those fixtures. An empty calendar keeps their expectations valid.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit** (checkpoint — ask first)

```bash
git add src/plugins/Essentials/scheduled-availability/services/
git commit -m "feat(scheduled-availability): skip report runs on brand market closures"
```

---

### Task 6: End-to-end verification against the running system

**Files:** none — this is manual confirmation on the dev box.

- [ ] **Step 1: Restart both processes**

Restart `dev:server` and `dev:worker`. Both are ts-node with no watch, so neither picks up any of the above until restarted, and the worker is what actually executes runs.

- [ ] **Step 2: Set a closure calendar for Kaaikani**

In Dashboard → System → Settings Store, with the channel switcher on **Coimbatore**, set `marketClosure.config` to:

```json
{ "closedWeekdays": [5], "closedDates": [] }
```

- [ ] **Step 3: Confirm the brand scope**

Switch the channel to **Madurai** and read `marketClosure.config` again. Expected: the same value, because both channels belong to seller 2 (Kaaikani). Switch to **South Mithai** (seller 3): expected empty, because that is a different brand.

- [ ] **Step 4: Confirm a closed-day run**

On a Friday — or temporarily set `closedWeekdays` to today's weekday — press **Run now** on schedule 27. Expected: no WhatsApp message, and a run in Run history showing the **Market closed** badge with the reason naming the date.

- [ ] **Step 5: Confirm the widened window**

Set `closedWeekdays` back to `[5]`, then press **Run now** on a Saturday. Expected: a PDF whose order count covers Friday and Saturday, and a run note reporting more rows than a single-day run.

- [ ] **Step 6: Confirm no regression for other brands**

Press **Run now** on a schedule belonging to a brand with an empty calendar. Expected: identical behaviour to before this feature — a single-day window.

---

## Deferred (not in this plan)

From the spec's optional-polish section, both explicitly out of scope here:

1. A dedicated closure form (weekday checkboxes plus an add/remove date list) following the `cancel-order` dashboard block pattern. The core Settings Store page is sufficient to ship.
2. Marking upcoming skipped occurrences in the schedule detail's "What will happen" preview.
