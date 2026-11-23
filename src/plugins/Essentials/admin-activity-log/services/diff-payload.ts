import { ADMIN_ACTIVITY_LOG_CONFIG } from '../constants';

const {
    MAX_CHANGED_FIELDS,
    DIFF_IGNORED_KEYS,
    MAX_PAYLOAD_DEPTH,
    MAX_CHANGE_VALUE_CHARS,
    DEPTH_TRUNCATION_MARKER,
    BYTE_TRUNCATION_KEY,
} = ADMIN_ACTIVITY_LOG_CONFIG;

type Json = Record<string, unknown>;

/**
 * One field that changed, with the values on either side.
 *
 * `from` and `to` are the SANITIZED payload values, so a redacted field reports
 * `[REDACTED]` on both sides rather than leaking a credential, and both are
 * capped to MAX_CHANGE_VALUE_CHARS. An array member that was added or removed
 * has `null` on the missing side — indistinguishable from a genuine null, which
 * is why the path itself is what carries the meaning there.
 */
export interface FieldChange {
    path: string;
    from: unknown;
    to: unknown;
}

/**
 * Works out which fields an administrator actually changed, and what they
 * changed from and to, by comparing the mutation payload against the payload of
 * the previous recorded change to the same entity.
 *
 * This exists because the Dashboard submits the WHOLE form on every save, not a
 * delta. Two consecutive `updateProduct` payloads for the same product differ in
 * one translation field and agree on everything else — yet both carry `enabled`,
 * every asset id and every translation. Reading a single payload therefore
 * cannot distinguish "the operator switched this product off" from "the operator
 * fixed a typo while the product happened to already be on".
 *
 * The comparison is structural and entity-agnostic on purpose: one implementation
 * covers Product, ProductVariant, Customer, Promotion and all ~40 custom plugins
 * without per-entity field mapping, which is what ruled out loading each entity
 * from the database instead.
 *
 * Returns the RICH result — path plus both values. Callers that only need the
 * paths project it down themselves (the writer does exactly that to fill the
 * `changedFields` column). Having one comparison with two projections is what
 * keeps the badge logic and the value display from ever disagreeing about what
 * changed; two separate implementations would drift.
 *
 * Known limit: the baseline is the previous LOGGED change. The first change to an
 * entity has nothing to compare against, and a change made outside the Admin API
 * leaves the next diff measured against a stale baseline.
 */
export function diffPayloads(
    previous: Json | null | undefined,
    current: Json | null | undefined,
): FieldChange[] | null {
    if (!isObject(previous) || !isObject(current)) {
        return null;
    }
    // A payload that blew the byte cap was replaced by a preview string and has
    // a different shape entirely. Comparing against it would find no keys in
    // common and report "no fields changed", which is a confident lie — the
    // truth is that nothing can be determined.
    if (previous[BYTE_TRUNCATION_KEY] === true || current[BYTE_TRUNCATION_KEY] === true) {
        return null;
    }
    const changes: FieldChange[] = [];
    collectChanges(unwrapInput(previous), unwrapInput(current), '', changes, 0);
    return changes.slice(0, MAX_CHANGED_FIELDS);
}

/**
 * Narrows a rich diff to the dotted paths alone.
 *
 * The `changedFields` column stores paths and nothing else, and four Dashboard
 * call sites test it with `.includes('enabled')`. Widening that column to
 * objects would make every one of those comparisons silently return false — no
 * error, just Enable/Disable badges that quietly stop appearing. Projecting here
 * instead keeps the stored shape exactly as it was.
 */
export function toChangedPaths(changes: FieldChange[] | null): string[] | null {
    return changes === null ? null : changes.map(change => change.path);
}

/**
 * Most admin mutations nest everything under a single `input` argument, so the
 * wrapper is stripped to keep paths readable — `enabled` rather than
 * `input.enabled`. Mutations with a different argument shape are compared as-is.
 */
function unwrapInput(payload: Json): Json {
    const input = payload.input;
    return isObject(input) ? input : payload;
}

function collectChanges(
    previous: Json,
    current: Json,
    prefix: string,
    changes: FieldChange[],
    depth: number,
): void {
    if (depth > MAX_PAYLOAD_DEPTH || changes.length >= MAX_CHANGED_FIELDS) {
        return;
    }
    // Only fields present on BOTH sides can be compared. An admin input omitting
    // a key means "leave this alone", not "set it to null" — so a key the
    // baseline never mentioned carries no information about its old value.
    //
    // This matters because one entity is edited through several payload shapes.
    // The product-stock toggle saves on its own with a two-field payload; the
    // Update button sends the entire form. Treating absent-versus-present as a
    // change made every full save that followed a toggle announce that `enabled`,
    // `assetIds` and every translation had changed, when nothing of the sort had
    // happened. Reporting a field we cannot observe is worse than staying quiet
    // about it.
    const keys = Object.keys(current).filter(key => Object.prototype.hasOwnProperty.call(previous, key));
    for (const key of keys) {
        if (DIFF_IGNORED_KEYS.includes(key as never)) {
            continue;
        }
        comparePair(previous[key], current[key], join(prefix, key), changes, depth);
    }
}

function comparePair(
    previousValue: unknown,
    currentValue: unknown,
    path: string,
    changes: FieldChange[],
    depth: number,
): void {
    if (changes.length >= MAX_CHANGED_FIELDS) {
        return;
    }
    // Either side being a depth marker means the real value was never stored, so
    // equality between two markers proves nothing and inequality against one
    // proves nothing either. Staying silent is the only honest option.
    if (previousValue === DEPTH_TRUNCATION_MARKER || currentValue === DEPTH_TRUNCATION_MARKER) {
        return;
    }
    if (Array.isArray(previousValue) && Array.isArray(currentValue)) {
        compareArrays(previousValue, currentValue, path, changes, depth);
        return;
    }
    if (isObject(previousValue) && isObject(currentValue)) {
        collectChanges(previousValue, currentValue, path, changes, depth + 1);
        return;
    }
    if (!isEqual(previousValue, currentValue)) {
        record(changes, path, previousValue, currentValue);
    }
}

/**
 * Arrays of translations are matched by `languageCode` rather than by position,
 * so reordering the languages is not reported as an edit to every one of them.
 * Arrays whose members carry no natural key (asset ids, facet value ids) are
 * compared whole and reported under the array's own name, because "assetIds
 * changed" is the useful statement — not "assetIds[2] changed".
 */
function compareArrays(
    previous: unknown[],
    current: unknown[],
    path: string,
    changes: FieldChange[],
    depth: number,
): void {
    const keyOf = pickArrayKey(previous, current);
    if (!keyOf) {
        if (!isEqual(previous, current)) {
            record(changes, path, previous, current);
        }
        return;
    }
    const previousByKey = indexBy(previous, keyOf);
    const currentByKey = indexBy(current, keyOf);
    for (const key of new Set([...previousByKey.keys(), ...currentByKey.keys()])) {
        const previousItem = previousByKey.get(key);
        const currentItem = currentByKey.get(key);
        if (previousItem === undefined || currentItem === undefined) {
            // One side has no member under this key at all, so this is an
            // addition or a removal rather than an edit. `null` stands in for
            // the absent side; the reader is expected to read the presence of a
            // value on only one side as "added" / "removed".
            record(changes, join(path, key), previousItem ?? null, currentItem ?? null);
            continue;
        }
        collectChanges(previousItem, currentItem, join(path, key), changes, depth + 1);
    }
}

/**
 * Returns the field to match array members on, or null when the array has no
 * natural key. `languageCode` wins over `id` because a translation's `id` is
 * absent until the row exists — the very first save of a Tamil translation sends
 * no id, and the next one does.
 *
 * `stockLocationId` is matched despite being numeric, and it is the one place
 * this otherwise entity-agnostic module knows an entity-specific key. It earns
 * that exception because without it the single most-inspected edit in this
 * catalogue — a stock level change — reports its before and after as two whole
 * JSON arrays rather than `40 -> 400`. Every other array in the admin API either
 * has a `languageCode`/`code` or is a bag of ids where the array-level statement
 * is the useful one.
 */
function pickArrayKey(
    previous: unknown[],
    current: unknown[],
): 'languageCode' | 'code' | 'stockLocationId' | null {
    const members = [...previous, ...current];
    if (members.length === 0) {
        return null;
    }
    for (const candidate of ['languageCode', 'code'] as const) {
        if (members.every(item => isObject(item) && typeof item[candidate] === 'string')) {
            return candidate;
        }
    }
    // Numeric as well as string, because GraphQL `ID` arguments arrive as either
    // depending on how the Dashboard serialised them.
    const isKeyed = members.every(
        item =>
            isObject(item) &&
            (typeof item.stockLocationId === 'string' || typeof item.stockLocationId === 'number'),
    );
    return isKeyed ? 'stockLocationId' : null;
}

function indexBy(items: unknown[], key: string): Map<string, Json> {
    const map = new Map<string, Json>();
    for (const item of items) {
        const value = isObject(item) ? item[key] : undefined;
        if (typeof value === 'string' || typeof value === 'number') {
            map.set(String(value), item as Json);
        }
    }
    return map;
}

function record(changes: FieldChange[], path: string, from: unknown, to: unknown): void {
    changes.push({ path, from: capValue(from), to: capValue(to) });
}

/**
 * Bounds a single reported value.
 *
 * Primitives pass through with their type intact, so the Dashboard receives the
 * number `40` rather than the string `"40"` and can format it as a number. A
 * composite value is only serialized when it is too large to carry as-is, and
 * then it degrades to a truncated JSON preview — a shape change the reader can
 * see, rather than a silently shortened object that still looks complete.
 */
function capValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return value.length > MAX_CHANGE_VALUE_CHARS
            ? `${value.slice(0, MAX_CHANGE_VALUE_CHARS)}…`
            : value;
    }
    if (value === null || value === undefined || typeof value !== 'object') {
        return value ?? null;
    }
    const json = JSON.stringify(value) ?? 'null';
    return json.length > MAX_CHANGE_VALUE_CHARS
        ? `${json.slice(0, MAX_CHANGE_VALUE_CHARS)}…`
        : value;
}

function join(prefix: string, key: string): string {
    return prefix === '' ? key : `${prefix}.${key}`;
}

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural equality by serialization. Payloads are already sanitized JSON —
 * no dates, functions or cycles survive `sanitizePayload` — so this is sound
 * here and avoids a deep-equality dependency.
 */
function isEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
