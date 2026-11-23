// Mirror of ../constants + ../functions/*. The Angular ui-devkit compiler copies only this
// `ui` folder into its build, so nothing outside it can be imported. Keep in sync with the
// backend copies — they are the source of truth for what actually gets messaged.

// The default channel's code is this internal sentinel; the UI shows a friendly label instead.
export const DEFAULT_CHANNEL_CODE = '__default_channel__';

export const CANCEL_ORDER_ALERT_KEY = 'cancelOrder.alertConfig';
export const CANCEL_ORDER_DEFAULT_ALERT_KEY = 'cancelOrder.defaultAlertConfig';

export interface CancelOrderAlertConfig {
    helloNumber: string;
    supportNumbers: string[];
    adminIds: string[];
}

export interface AdminOption {
    id: string;
    name: string;
    email: string;
    /** Empty when the admin has no phoneNumber custom field saved — they cannot be messaged. */
    phone: string;
}

export const DEFAULT_CANCEL_ORDER_ALERT_CONFIG: CancelOrderAlertConfig = {
    helloNumber: '919894681385',
    supportNumbers: ['916380774767', '916379993190', '917868000215', '917845847259'],
    adminIds: [],
};

export function normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length === 10) {
        return `91${digits}`;
    }
    return digits;
}

export function sanitizeNumbers(numbers: ReadonlyArray<string> | undefined | null): string[] {
    const cleaned = (numbers ?? [])
        .map(number => normalizePhone(String(number)))
        .filter(number => number.length > 0);
    return Array.from(new Set(cleaned));
}

export function sanitizeIds(ids: ReadonlyArray<string | number> | undefined | null): string[] {
    const cleaned = (ids ?? []).map(id => String(id).trim()).filter(id => id.length > 0);
    return Array.from(new Set(cleaned));
}

/**
 * Layered resolution, most-specific first: channel layer -> shared default layer -> seed
 * defaults. A layer counts as "set" when it names an administrator OR an ad-hoc number, and
 * is then taken whole. Env vars are server-side only, so this browser copy skips that layer.
 */
export function resolveAlertConfig(input: {
    channel?: Partial<CancelOrderAlertConfig> | null;
    global?: Partial<CancelOrderAlertConfig> | null;
}): CancelOrderAlertConfig {
    const { channel, global } = input;

    const helloNumber =
        normalizePhone(channel?.helloNumber ?? '') ||
        normalizePhone(global?.helloNumber ?? '') ||
        DEFAULT_CANCEL_ORDER_ALERT_CONFIG.helloNumber;

    const layers = [
        { adminIds: sanitizeIds(channel?.adminIds), supportNumbers: sanitizeNumbers(channel?.supportNumbers) },
        { adminIds: sanitizeIds(global?.adminIds), supportNumbers: sanitizeNumbers(global?.supportNumbers) },
        { adminIds: [] as string[], supportNumbers: DEFAULT_CANCEL_ORDER_ALERT_CONFIG.supportNumbers },
    ];
    const chosen =
        layers.find(layer => layer.adminIds.length > 0 || layer.supportNumbers.length > 0) ??
        { adminIds: [] as string[], supportNumbers: [] as string[] };

    return { helloNumber, adminIds: chosen.adminIds, supportNumbers: chosen.supportNumbers };
}
