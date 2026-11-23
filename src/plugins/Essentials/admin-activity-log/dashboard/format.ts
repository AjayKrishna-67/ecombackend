import type { AdminActivityLogRow } from './queries';

/**
 * Turns a raw row into the sentence an operator actually wants to read.
 *
 * The log stores what the API was asked to do (`updateProduct` with an input
 * blob). Nobody investigating a missing product wants to parse that, so this
 * reads the intent back out of the payload: an `updateProduct` carrying
 * `enabled: false` is a DISABLE, which is the single most common thing anyone
 * will come here looking for.
 */
export function describeAction(row: AdminActivityLogRow): string {
    if (row.isAuthEvent) {
        return AUTH_LABELS[row.operationName] ?? row.operationName;
    }
    const input = extractInput(row.payload);
    const verb = deriveVerb(row.operationName, input, row.changedFields);
    const count = row.targetCount > 1 ? ` (${row.targetCount} items)` : '';
    // No verb matched and no entity resolved: this is a read from the sensitive
    // allowlist (`purchaseList`, `reportData`). Naming it alone reads far better
    // than the old "<operation> record", which produced "orders record".
    if (verb === null) {
        return `${humanise(row.operationName)}${count}`;
    }
    const subject = row.entityType ? humaniseEntityType(row.entityType) : 'record';
    return `${verb} ${subject}${describeTarget(row)}${count}`;
}

/**
 * Names the thing that was acted on, preferring the name an operator would
 * recognise over the database id they would have to look up.
 *
 * The name comes from the row's own payload, so it is the name the entity had
 * WHEN THE ACTION HAPPENED. A product renamed since still reads here under its
 * old name, which is the point of an audit trail — the alternative quietly
 * rewrites history every time someone edits a title.
 *
 * Falls back to the id, because `#949` is a poor label but a true one, and a
 * row with no identifiable target at all says nothing rather than inventing.
 */
function describeTarget(row: AdminActivityLogRow): string {
    if (row.entityLabel) {
        return `: ${row.entityLabel}`;
    }
    return row.entityId ? ` #${row.entityId}` : '';
}

/** `ProductVariant` reads as "product variant", not "productvariant". */
function humaniseEntityType(entityType: string): string {
    return entityType.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function humanise(operationName: string): string {
    const spaced = operationName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const AUTH_LABELS: Record<string, string> = {
    LOGIN: 'Signed in',
    LOGOUT: 'Signed out',
    LOGIN_FAILED: 'Failed sign-in attempt',
};

/**
 * `enabled` promotes an edit to an explicit Enable/Disable, but ONLY when the
 * diff confirms that field actually changed.
 *
 * An earlier version read `input.enabled` straight from the payload, which was
 * wrong: the Dashboard resubmits the entire form on every save, so a product
 * that was already live and had its description corrected still arrived carrying
 * `enabled: true` — and the log announced "Enabled product #731" for an edit
 * that enabled nothing. Reporting a submitted value as if it were a change is
 * the specific failure this guard closes.
 *
 * When `changedFields` is null there is no baseline to trust, so the operation
 * name alone decides. "Updated product" understates a genuine disable, but it
 * never asserts something that did not happen.
 */
function deriveVerb(
    operationName: string,
    input: Record<string, unknown> | null,
    changedFields: string[] | null,
): string | null {
    if (changedFields?.includes('enabled') && input && typeof input.enabled === 'boolean') {
        return input.enabled ? 'Enabled' : 'Disabled';
    }
    if (/^delete/i.test(operationName)) {
        return 'Deleted';
    }
    if (/^(create|add)/i.test(operationName)) {
        return 'Created';
    }
    if (/^export/i.test(operationName)) {
        return 'Exported';
    }
    if (/^(update|set|assign|remove)/i.test(operationName)) {
        return 'Updated';
    }
    return null;
}

function extractInput(payload: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!payload) {
        return null;
    }
    const input = payload.input;
    if (Array.isArray(input)) {
        return (input[0] as Record<string, unknown>) ?? null;
    }
    if (input && typeof input === 'object') {
        return input as Record<string, unknown>;
    }
    return payload;
}

/** Destructive actions are tinted so a scan of the list surfaces them first. */
export function isDestructive(row: AdminActivityLogRow): boolean {
    if (/^delete/i.test(row.operationName)) {
        return true;
    }
    // Same guard as `deriveVerb`: a resubmitted `enabled: false` on a product
    // that was already off is not someone switching it off, and flagging it
    // destructive would train operators to ignore the amber badge.
    const input = extractInput(row.payload);
    return !!input && input.enabled === false && row.changedFields?.includes('enabled') === true;
}

/** One changed field, ready to render as "Stock levels  40 -> 400". */
export interface ChangeSummary {
    label: string;
    from: string | null;
    to: string | null;
}

/**
 * What a mutation actually changed, one entry per field, with the value on
 * either side where the server could derive it.
 *
 * Returns null when there is nothing trustworthy to say — no baseline existed,
 * or the row is a create, a delete or a failure. An EMPTY array is a different
 * statement and a deliberate one: the diff ran and found nothing, i.e. someone
 * resaved a form without editing it, which is itself worth seeing.
 *
 * `from`/`to` are null when only the stored path list is available. That happens
 * on a row whose predecessor payload could not be read back, and the field name
 * alone is still worth showing — a missing value must not hide the fact that the
 * field changed.
 */
export function describeChanges(row: AdminActivityLogRow): ChangeSummary[] | null {
    // `changes` is recomputed on every read; `changedFields` is a snapshot of
    // whatever the diff produced on the day the row was written. When both
    // exist the fresh one wins, because the stored list can be a generation
    // behind: rows written before stock levels were matched per location hold
    // the path `stockLevels`, while today's diff yields
    // `stockLevels.2.stockOnHand`. Keying values off the stored list would find
    // no match for those rows and silently drop every value it had just derived.
    if (row.changes) {
        return row.changes.map(change => ({
            label: humaniseFieldPath(change.path),
            from: formatChangeValue(change.from),
            to: formatChangeValue(change.to),
        }));
    }
    const changed = row.changedFields;
    if (changed === null || changed === undefined) {
        return null;
    }
    return changed.map(path => ({ label: humaniseFieldPath(path), from: null, to: null }));
}

/**
 * Renders one before/after value as the shortest true thing.
 *
 * Empty string and null are spelled out rather than rendered as nothing at all,
 * because a blank cell beside an arrow reads as a rendering bug. Booleans become
 * yes/no since every boolean in this admin is a toggle an operator flipped, and
 * "enabled: false -> true" is read more slowly than "no -> yes".
 */
export function formatChangeValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '—';
    }
    if (typeof value === 'boolean') {
        return value ? 'yes' : 'no';
    }
    if (typeof value === 'number') {
        return String(value);
    }
    if (typeof value === 'string') {
        return value.trim() === '' ? '(empty)' : value;
    }
    return JSON.stringify(value);
}

/** Beyond this many field names the line stops being scannable. */
export const MAX_LISTED_FIELDS = 4;

const LANGUAGE_NAMES: Record<string, string> = {
    en: 'English',
    ta: 'Tamil',
    ml: 'Malayalam',
    hi: 'Hindi',
};

/**
 * Renders one dotted diff path as a phrase.
 *
 * Translation paths carry the language into a suffix — `translations.ta.name`
 * becomes "Name (Tamil)" — because on a multi-language catalogue "which language
 * did they edit" is usually the actual question. `customFields` is dropped from
 * the path entirely: an operator sees "Local name" on the form and has no idea
 * it lives under customFields in the API.
 */
export function humaniseFieldPath(path: string): string {
    const segments = path.split('.');
    // `stockLevels.2.stockOnHand` is the shape produced by matching stock rows
    // on their location. "Stock levels 2 stock on hand" is what the generic rule
    // would make of it, which reads as gibberish on the one field operators
    // check most.
    if (segments[0] === 'stockLevels' && segments.length >= 2) {
        const field = segments.slice(2).join(' ');
        return field === ''
            ? `Stock at location ${segments[1]}`
            : `${humanise(field)} (location ${segments[1]})`;
    }
    if (segments[0] === 'translations' && segments.length >= 3) {
        const language = LANGUAGE_NAMES[segments[1]] ?? segments[1];
        const field = segments.slice(2).filter(part => part !== 'customFields').join(' ');
        return `${humanise(field)} (${language})`;
    }
    return humanise(segments.filter(part => part !== 'customFields').join(' '));
}

export interface DeviceInfo {
    browser: string;
    os: string;
    deviceType: 'Desktop' | 'Mobile' | 'Tablet';
}

/**
 * Parses a user-agent header into browser, OS and device type.
 *
 * Runs in the Dashboard rather than at capture time so the raw UA is stored once
 * per session and the interpretation can be corrected without a migration —
 * user-agent strings are a moving target and any parser dates quickly.
 *
 * KNOWN LIMIT — Brave is undetectable here, and always reports as Chrome. Brave
 * ships a byte-for-byte Chrome user-agent on purpose, as an anti-fingerprinting
 * measure; nothing in the request headers distinguishes it. Only
 * `navigator.brave.isBrave()`, running inside the page, can tell. Treat "Chrome"
 * as "Chrome or Brave".
 *
 * Order matters throughout: Edge and Opera both embed "Chrome" in their UA, and
 * every Chromium browser embeds "Safari", so the more specific token has to be
 * tested first or everything collapses into Chrome.
 */
export function parseUserAgent(userAgent: string | null | undefined): DeviceInfo | null {
    if (!userAgent) {
        return null;
    }
    return {
        browser: detectBrowser(userAgent),
        os: detectOs(userAgent),
        deviceType: detectDeviceType(userAgent),
    };
}

function detectBrowser(ua: string): string {
    const checks: Array<[RegExp, string]> = [
        [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
        [/OPR\/(\d+)|Opera\/(\d+)/, 'Opera'],
        [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
        [/Firefox\/(\d+)/, 'Firefox'],
        [/Chrome\/(\d+)/, 'Chrome'],
        [/Version\/(\d+).*Safari/, 'Safari'],
        [/curl\/(\d+)/, 'curl'],
    ];
    for (const [pattern, name] of checks) {
        const match = ua.match(pattern);
        if (match) {
            const version = match[1] ?? match[2];
            return version ? `${name} ${version}` : name;
        }
    }
    return 'Unknown browser';
}

function detectOs(ua: string): string {
    // Ubuntu must precede the generic Linux check, since Ubuntu's UA contains both.
    if (/Ubuntu/i.test(ua)) return 'Ubuntu';
    if (/Android/i.test(ua)) return 'Android';
    if (/(iPhone|iPad|iPod)/i.test(ua)) return 'iOS';
    if (/Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'Unknown OS';
}

function detectDeviceType(ua: string): DeviceInfo['deviceType'] {
    if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) {
        return 'Tablet';
    }
    // Android phones always carry "Mobile"; tablets omit it. That token is the
    // only reliable phone-vs-tablet signal in the string.
    if (/Mobi|iPhone|iPod|Windows Phone/i.test(ua)) {
        return 'Mobile';
    }
    return 'Desktop';
}

export function formatDuration(ms: number): string {
    if (ms < 1_000) {
        return `${ms}ms`;
    }
    return `${(ms / 1_000).toFixed(1)}s`;
}

/**
 * How long a pause must be before the timeline calls it idle. Short enough to
 * still show a real break in the working day, long enough that reading a page,
 * filling in a form or taking a phone call does not litter the timeline with
 * gaps that mean nothing.
 */
const IDLE_GAP_THRESHOLD_MS = 30 * 60 * 1_000;

export function formatGap(fromIso: string, toIso: string): string | null {
    const gapMs = new Date(toIso).getTime() - new Date(fromIso).getTime();
    if (gapMs < IDLE_GAP_THRESHOLD_MS) {
        return null;
    }
    const minutes = Math.round(gapMs / 60_000);
    if (minutes < 60) {
        return `${minutes}m idle`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m idle`;
}
