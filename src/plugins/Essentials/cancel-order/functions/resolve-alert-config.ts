import { DEFAULT_CANCEL_ORDER_ALERT_CONFIG } from '../constants';
import { CancelOrderAlertConfig } from './../types';
import { normalizePhone } from './normalize-phone';

/**
 * Cleans a stored/typed number list: normalises each entry, drops blanks, de-dupes.
 * Duplicate recipients cost a duplicate MSG91 message each, hence the de-dupe.
 */
export function sanitizeNumbers(numbers: ReadonlyArray<string> | undefined | null): string[] {
    const cleaned = (numbers ?? [])
        .map(number => normalizePhone(String(number)))
        .filter(number => number.length > 0);
    return Array.from(new Set(cleaned));
}

/** Cleans a stored admin id list: stringifies, drops blanks, de-dupes. */
export function sanitizeIds(ids: ReadonlyArray<string | number> | undefined | null): string[] {
    const cleaned = (ids ?? []).map(id => String(id).trim()).filter(id => id.length > 0);
    return Array.from(new Set(cleaned));
}

/**
 * Resolves the effective alert recipients for one channel, most-specific layer first:
 *
 *   channel layer -> shared default layer -> env vars -> hardcoded seed defaults
 *
 * A layer counts as "set" when it names at least one administrator OR one ad-hoc number;
 * the whole layer is then taken as a unit, so a channel that picks two admins does not
 * silently inherit the default list's numbers as well. An entirely empty layer is treated
 * as "not configured" rather than "send to nobody" — that is what makes the shared default
 * work as a fallback.
 *
 * `adminIds` are returned unresolved: turning them into phone numbers needs a DB lookup,
 * which is the caller's job. Keeping that out means this stays pure and unit-testable.
 */
export function resolveAlertConfig(input: {
    channel?: Partial<CancelOrderAlertConfig> | null;
    global?: Partial<CancelOrderAlertConfig> | null;
    env?: { helloNumber?: string; supportNumbers?: string };
}): CancelOrderAlertConfig {
    const { channel, global, env = {} } = input;

    const helloNumber =
        normalizePhone(channel?.helloNumber ?? '') ||
        normalizePhone(global?.helloNumber ?? '') ||
        normalizePhone(env.helloNumber ?? '') ||
        DEFAULT_CANCEL_ORDER_ALERT_CONFIG.helloNumber;

    const layers = [
        { adminIds: sanitizeIds(channel?.adminIds), supportNumbers: sanitizeNumbers(channel?.supportNumbers) },
        { adminIds: sanitizeIds(global?.adminIds), supportNumbers: sanitizeNumbers(global?.supportNumbers) },
        { adminIds: [], supportNumbers: sanitizeNumbers((env.supportNumbers ?? '').split(',')) },
        { adminIds: [], supportNumbers: DEFAULT_CANCEL_ORDER_ALERT_CONFIG.supportNumbers },
    ];
    const chosen =
        layers.find(layer => layer.adminIds.length > 0 || layer.supportNumbers.length > 0) ??
        { adminIds: [], supportNumbers: [] };

    return { helloNumber, adminIds: chosen.adminIds, supportNumbers: chosen.supportNumbers };
}
