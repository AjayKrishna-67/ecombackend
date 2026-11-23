/**
 * Tuning constants for the admin activity log.
 *
 * These exist as named constants rather than inline literals because every one
 * of them is a load-bearing tradeoff between forensic coverage and write load on
 * a shared production database.
 */
export const ADMIN_ACTIVITY_LOG_CONFIG = {
    /**
     * Argument keys whose values are never persisted. Matching is
     * case-insensitive and by substring, so `newPassword` and `currentPassword`
     * are both caught by `password`.
     *
     * Logging raw admin mutation arguments would write plaintext credentials
     * from `createAdministrator` / `updateAdministrator` into a table that any
     * audit-log reader can query. That is a worse hole than the one this plugin
     * closes, so redaction happens in the writer and is not optional.
     */
    REDACTED_KEY_FRAGMENTS: [
        'password',
        'token',
        'secret',
        'apikey',
        'api_key',
        'privatekey',
        'private_key',
        'authorization',
        'credential',
        'otp',
        'pin',
    ],

    /** Placeholder written in place of a redacted value. */
    REDACTED_PLACEHOLDER: '[REDACTED]',

    /**
     * Placeholder written in place of a value nested deeper than
     * MAX_PAYLOAD_DEPTH. Shared with the diff, which must treat it as "unknown"
     * rather than as a value — two markers are not evidence that two different
     * values are equal.
     */
    DEPTH_TRUNCATION_MARKER: '[TRUNCATED_DEPTH]',

    /**
     * Key marking a payload that blew the byte cap and was replaced by a preview.
     * Such a payload has a completely different shape, so it can neither be
     * diffed against nor diffed from.
     */
    BYTE_TRUNCATION_KEY: '_truncated',

    /**
     * Hard cap on the serialized payload. The product-import and bulk price
     * mutations can carry megabytes; without a cap a single import would write
     * more bytes than a month of normal activity.
     */
    MAX_PAYLOAD_BYTES: 8_000,

    /** Longest a single string value may be before truncation. */
    MAX_STRING_LENGTH: 512,

    /**
     * Deepest object nesting retained in the payload.
     *
     * Six, not four, because Vendure's product input reaches a translated custom
     * field at depth five: args -> input -> translations -> item -> customFields
     * -> localName. At four that value was stored as `[TRUNCATED_DEPTH]`, which
     * lost the value AND blinded the diff — two edits to the same translated
     * custom field both serialised to the same marker and compared equal, so a
     * real change was reported as no change. MAX_PAYLOAD_BYTES still bounds the
     * total, so the extra depth cannot run away.
     */
    MAX_PAYLOAD_DEPTH: 6,

    /** Longest array retained in the payload; the rest is summarized as a count. */
    MAX_ARRAY_LENGTH: 20,

    /** Buffer flush cadence. One bulk INSERT per interval instead of one per mutation. */
    FLUSH_INTERVAL_MS: 2_000,

    /** Flush early once the buffer reaches this many rows. */
    FLUSH_ROW_THRESHOLD: 200,

    /**
     * Absolute buffer ceiling. Beyond this, rows are dropped with a warning
     * rather than growing without bound. A bulk price sync already took this
     * server down once; an unbounded audit buffer must not be the cause of the
     * second time.
     */
    MAX_BUFFER_ROWS: 2_000,

    /**
     * Mutations that are never logged. These are either high-churn storefront-driven
     * noise or already carry their own audit trail (Vendure writes HistoryEntry
     * rows for Order and Customer).
     */
    IGNORED_OPERATIONS: [
        'login',
        'logout',
        'refreshCustomerVerification',
        'setActiveChannel',
        // The Dashboard persists its own UI preferences (theme, language, nav
        // state) through this mutation on almost every interaction. It is a
        // genuine mutation, so the mutations-only rule captures it, but it
        // records the operator's screen settings rather than anything anyone
        // would ever investigate.
        'setSettingsStoreValue',
    ],

    /**
     * Read operations logged despite the mutations-only rule, because bulk PII
     * egress is exactly the trail that matters.
     *
     * Restricted to operations that EXPORT or REPORT. The `customers` and
     * `orders` list queries were originally here on "bulk PII" reasoning, which
     * was wrong: they back the two most-visited pages in the admin UI, so
     * ordinary browsing buried the signal (five `orders` rows from opening the
     * order list once). Reading a list on screen is not egress; downloading it
     * is.
     */
    SENSITIVE_READ_OPERATIONS: ['exportCustomers', 'reportData', 'purchaseList'],

    /**
     * Minimum gap between `lastSeenAt` writes for a single session. Writing it on
     * every request would put the database back under the load that took the
     * server down; sessions are also served from the Redis cache for
     * `sessionCacheTTL` seconds, so per-request precision is unattainable anyway.
     */
    LAST_SEEN_THROTTLE_MS: 10 * 60 * 1_000,

    /**
     * Longest list of changed field paths stored on a row. A bulk edit that
     * rewrites every translation of a 40-variant product would otherwise store a
     * field list longer than the payload it summarizes; past this the list is
     * truncated and the UI reports the remainder as a count.
     */
    MAX_CHANGED_FIELDS: 25,

    /**
     * Longest a single before/after value may be when it is carried alongside a
     * changed field path.
     *
     * Much tighter than MAX_STRING_LENGTH because these values are rendered
     * inline on a timeline row, not stored. A product description diff would
     * otherwise put two 512-character HTML blobs into a line meant to be
     * scanned in a second. The untruncated value is always one click away in the
     * payload, so nothing is actually lost by capping hard here.
     */
    MAX_CHANGE_VALUE_CHARS: 120,

    /**
     * Keys ignored when diffing one payload against the previous one. These are
     * identity and ordering artefacts, not edits: `id` appears on a translation
     * only after the first save creates the row, so including it would report
     * three phantom changes the next time anyone touches the product.
     */
    DIFF_IGNORED_KEYS: ['id', 'createdAt', 'updatedAt'],

    /** Rows older than this are removed by the prune task. */
    RETENTION_DAYS: 180,

    /** Rows deleted per prune batch, to avoid a single long-running DELETE. */
    PRUNE_BATCH_SIZE: 5_000,
} as const;
