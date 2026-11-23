/**
 * Dropdown model for the Pickup Time editor in the Store Location card.
 *
 * Kept in the ui/ folder (and mirrored in dashboard/) rather than imported
 * from the plugin's pickup-slot.ts: the admin compiler copies this folder on
 * its own into the Angular build, so a relative import outside it would not
 * resolve there. The text produced here must stay exactly what the server's
 * TIME_PATTERN accepts: `h:mm AM`, one space, upper-case meridiem.
 */
export interface TimeParts {
    hour: string;
    minute: string;
    meridiem: string;
}

export const HOURS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
export const MINUTES = ['00', '15', '30', '45'];
export const MERIDIEMS = ['AM', 'PM'];

export const EMPTY_PARTS: TimeParts = { hour: '', minute: '', meridiem: '' };

/** `"10:00 AM"` → dropdown parts; anything else → all empty. */
export function splitPickupTime(value: unknown): TimeParts {
    const match = typeof value === 'string' ? /^(0?[1-9]|1[0-2]):([0-5][0-9]) (AM|PM)$/.exec(value) : null;
    if (!match) {
        return { ...EMPTY_PARTS };
    }
    return { hour: String(Number(match[1])), minute: match[2], meridiem: match[3] };
}

/** Dropdown parts → `"10:00 AM"`, or null while any part is still unset. */
export function joinPickupTime(parts: TimeParts): string | null {
    if (!parts.hour || !parts.minute || !parts.meridiem) {
        return null;
    }
    return `${parts.hour}:${parts.minute} ${parts.meridiem}`;
}

/** Minutes since midnight for an ordering check between the two ends. */
export function pickupTimeToMinutes(value: string | null): number | null {
    const parts = splitPickupTime(value);
    if (!parts.hour) {
        return null;
    }
    return ((Number(parts.hour) % 12) + (parts.meridiem === 'PM' ? 12 : 0)) * 60 + Number(parts.minute);
}

/** Inline message for the editor, mirroring the server's own checks. */
export function pickupWindowMessage(from: string | null, to: string | null): string {
    if (!from && !to) {
        return '';
    }
    if (!from || !to) {
        return 'Set both the start and the end of the pickup time';
    }
    const start = pickupTimeToMinutes(from);
    const end = pickupTimeToMinutes(to);
    if (start != null && end != null && end <= start) {
        return 'The pickup time must end after it starts';
    }
    return '';
}
