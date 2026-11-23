import { ADMIN_ACTIVITY_LOG_CONFIG } from '../constants';

const {
    REDACTED_KEY_FRAGMENTS,
    REDACTED_PLACEHOLDER,
    DEPTH_TRUNCATION_MARKER,
    BYTE_TRUNCATION_KEY,
    MAX_PAYLOAD_BYTES,
    MAX_STRING_LENGTH,
    MAX_PAYLOAD_DEPTH,
    MAX_ARRAY_LENGTH,
} = ADMIN_ACTIVITY_LOG_CONFIG;

function isRedactedKey(key: string): boolean {
    const lower = key.toLowerCase();
    return REDACTED_KEY_FRAGMENTS.some(fragment => lower.includes(fragment));
}

function truncateString(value: string): string {
    if (value.length <= MAX_STRING_LENGTH) {
        return value;
    }
    return `${value.slice(0, MAX_STRING_LENGTH)}…[+${value.length - MAX_STRING_LENGTH} chars]`;
}

function sanitizeArray(value: unknown[], depth: number): unknown[] {
    const kept = value.slice(0, MAX_ARRAY_LENGTH).map(item => sanitizeValue(item, depth + 1));
    if (value.length <= MAX_ARRAY_LENGTH) {
        return kept;
    }
    return [...kept, `…[+${value.length - MAX_ARRAY_LENGTH} more]`];
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        result[key] = isRedactedKey(key) ? REDACTED_PLACEHOLDER : sanitizeValue(child, depth + 1);
    }
    return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
    if (value === null || value === undefined) {
        return null;
    }
    if (depth > MAX_PAYLOAD_DEPTH) {
        return DEPTH_TRUNCATION_MARKER;
    }
    if (typeof value === 'string') {
        return truncateString(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        return sanitizeArray(value, depth);
    }
    if (typeof value === 'object') {
        return sanitizeObject(value as Record<string, unknown>, depth);
    }
    return String(value);
}

/**
 * Strips credentials and bounds the size of GraphQL mutation arguments before
 * they are persisted to the audit log.
 *
 * Three guarantees, in priority order:
 * 1. No value under a key matching {@link ADMIN_ACTIVITY_LOG_CONFIG.REDACTED_KEY_FRAGMENTS}
 *    is ever returned. `createAdministrator` args carry a plaintext password.
 * 2. The serialized result never exceeds `MAX_PAYLOAD_BYTES`. A product import
 *    mutation can otherwise carry megabytes into a single row.
 * 3. It never throws. A sanitization failure must not fail the mutation being
 *    audited, so unserializable input degrades to an error marker instead.
 */
export function sanitizePayload(args: unknown): Record<string, unknown> | null {
    if (args === null || args === undefined || typeof args !== 'object') {
        return null;
    }
    try {
        const sanitized = sanitizeObject(args as Record<string, unknown>, 0);
        const serialized = JSON.stringify(sanitized);
        if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) {
            return sanitized;
        }
        return {
            [BYTE_TRUNCATION_KEY]: true,
            _originalBytes: Buffer.byteLength(serialized, 'utf8'),
            _preview: serialized.slice(0, MAX_PAYLOAD_BYTES),
        };
    } catch (err: unknown) {
        return { _sanitizeError: err instanceof Error ? err.message : 'unknown' };
    }
}
