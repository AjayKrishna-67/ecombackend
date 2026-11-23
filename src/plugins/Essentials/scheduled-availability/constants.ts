/**
 * Shared vocabulary for the scheduled-availability plugin.
 *
 * Dependency-free on purpose: entities, pure functions, the sweep task and the
 * API layer all import from here, so any import of its own would risk a cycle.
 * TypeORM decorators evaluate at module-load time, and a cycle surfaces as
 * "Column type for X cannot be guessed" rather than as an import error.
 */

/** Entity kinds a schedule can flip. Values match Vendure entity names exactly. */
export type AvailabilityTargetType = 'Product' | 'Collection';

/**
 * What a rule does when it fires.
 *
 * A separate discriminator rather than a third `AvailabilityTargetType`: that
 * type means "product or collection" to the target picker, `assertTargetExists`,
 * the target-name decorator and the applier registry. A third value there would
 * break all four at once, where a new field breaks nothing.
 */
export type ScheduleKind = 'AVAILABILITY' | 'REPORT';

export const DEFAULT_SCHEDULE_KIND: ScheduleKind = 'AVAILABILITY';

/** Reports a rule can deliver. One for now; the column exists so adding a second is a migration-free change. */
export type ScheduledReportType = 'PURCHASE_LIST';

/**
 * Which orders a report covers. Resolved at send time in the rule's own
 * timezone, not the server's -- a 21:00 Asia/Kolkata run is still "today" in
 * India while the server clock already reads tomorrow in UTC.
 */
export type ReportDateRangeMode = 'TODAY' | 'YESTERDAY';

/** Direction of a scheduled change. Becomes a GraphQL enum in the admin API. */
export type AvailabilityAction = 'ENABLE' | 'DISABLE' | 'SEND';

/** ONE_OFF fires once at `runAt`; RECURRING expands cron patterns per occurrence. */
export type AvailabilityScheduleMode = 'ONE_OFF' | 'RECURRING';

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

/** Which boolean a change-log row describes. Differs per target type. */
export type AvailabilityChangeField = 'enabled' | 'isPrivate';

/**
 * Who flipped a target. ADMIN means the request carried an authenticated user;
 * SYSTEM covers the sweeper, imports and any other unauthenticated context --
 * it cannot tell those apart, only that no human was on the request.
 */
export type AvailabilityChangeSource = 'ADMIN' | 'SYSTEM';

/** IANA zone used to interpret cron patterns when a rule does not override it. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Kolkata';

/** TEST MODE: set AVAILABILITY_SWEEP_EVERY_MIN=1 to sweep every minute. Default 1. */
export const AVAILABILITY_SWEEP_EVERY_MIN = Number(process.env.AVAILABILITY_SWEEP_EVERY_MIN ?? '1');

/** How far ahead occurrences are materialised into run rows. */
export const MATERIALISATION_HORIZON_HOURS = 48;

/**
 * A run due longer ago than this is marked SKIPPED instead of applied. Stops a
 * worker that was down overnight from disabling a storefront at 03:00.
 */
export const STALE_RUN_GRACE_MINUTES = 120;

/**
 * A run left RUNNING for longer than this is reclaimed to PENDING. Without it,
 * a worker killed mid-run (task timeout, OOM, deploy) leaves rows that no query
 * will ever pick up again, and nothing reports that they are stuck.
 */
export const STUCK_RUN_RECLAIM_MINUTES = 15;

/** Occurrences returned by the preview query when the caller gives no count. */
export const DEFAULT_PREVIEW_COUNT = 10;

/**
 * Approved MSG91/WhatsApp template carrying a document header.
 *
 * The template's body text and header format are frozen at approval, so this is
 * a name, not a message. Changing the wording means submitting a new template
 * and pointing this at it.
 */
export const REPORT_WHATSAPP_TEMPLATE = process.env.MSG91_REPORT_TEMPLATE ?? 'scheduling';

/**
 * SettingsStore key for a brand's market closure calendar.
 *
 * Scoped by seller, not channel -- see the scope function in the plugin file.
 */
export const MARKET_CLOSURE_SETTING_KEY = 'marketClosure.config';

/**
 * How long a locally-saved report PDF is kept before the prune task deletes it.
 *
 * The local copy is a debug artifact -- the document WhatsApp actually delivers
 * lives in object storage (see ReportStorageService), so nothing breaks when one
 * of these is removed. Without a retention the directory grows for the life of
 * the server, because every run writes a uniquely-named file by design.
 *
 * Zero or negative DISABLES pruning rather than deleting everything: an operator
 * who types `REPORT_LOCAL_RETENTION_DAYS=0` meaning "keep nothing" gets a no-op,
 * which is the harmless reading of an ambiguous value.
 */
export const REPORT_LOCAL_RETENTION_DAYS = Number(process.env.REPORT_LOCAL_RETENTION_DAYS ?? '7');

/**
 * Hour of the day the prune task runs, in the SERVER's timezone.
 *
 * Deliberately not the rule timezone: this deletes files by age, and age is
 * absolute. 03:00 keeps it away from the 09:00-17:00 window the report schedules
 * actually fire in.
 */
export const REPORT_PRUNE_HOUR = Number(process.env.REPORT_PRUNE_HOUR ?? '3');

/**
 * Placeholder document served until the report renderer exists.
 *
 * Deliberately a real, publicly fetchable PDF: Meta downloads the URL itself at
 * send time, so a fake one would fail in a way that looks like a template
 * problem rather than a missing renderer. Replaced once the dashboard's
 * Chromium-rendered purchase list is wired in.
 */
export const REPORT_SAMPLE_PDF_URL =
    process.env.REPORT_SAMPLE_PDF_URL ??
    'https://kaaikani.co.in/assets/source/e6/interns-tasklist.pdf';
