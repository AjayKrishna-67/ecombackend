import { ShippingMethod } from '@vendure/core';

/** The store's daily collection window, both ends as `h:mm AM` / `h:mm PM` text. */
export interface PickupSlot {
    from: string;
    to: string;
}

declare module '@vendure/core' {
    interface CustomShippingMethodFields {
        /** Registered by TakeAwayPlugin: the hours customers collect in, the same every day. */
        pickupSlot?: PickupSlot | null;
    }
    interface CustomOrderFields {
        /** Registered by TakeAwayPlugin: the method's hours as they were when the order was placed. */
        pickupSlot?: PickupSlot | null;
        /** Registered by TakeAwayPlugin: the time the customer chose within those hours. */
        pickupTime?: string | null;
    }
}

export const PICKUP_TIME_FORMAT_ERROR = 'Enter the time as h:mm AM or h:mm PM, for example 10:00 AM';
export const PICKUP_SLOT_ORDER_ERROR = 'The pickup hours must end after they start';
export const PICKUP_SLOT_INCOMPLETE_ERROR = 'Set both the start and the end of the pickup hours';
export const PICKUP_TIME_OUTSIDE_ERROR = "Choose a pickup time within the store's pickup hours";

/** Spacing of the times the customer can choose between the hours' start and end. */
export const PICKUP_TIME_STEP_MINUTES = 15;

// Exactly one space and upper-case AM/PM: what the admin picks is what the
// app shows, so the stored text is kept in one agreed form. A leading zero on
// the hour is tolerated because "09:00 AM" is a common way to type it.
const TIME_PATTERN = /^(0?[1-9]|1[0-2]):([0-5][0-9]) (AM|PM)$/;

/**
 * Whether a stored slot actually holds a window. Vendure returns an unset
 * struct as an object whose members are null (`{ from: null, to: null }`)
 * rather than null itself, and the admin form sends that shape back, so
 * "no window" has to be recognised in both forms.
 */
export function isPickupSlotSet(slot: Partial<PickupSlot> | null | undefined): slot is PickupSlot {
    return typeof slot?.from === 'string' && slot.from !== '' && typeof slot?.to === 'string' && slot.to !== '';
}

/** `"10:00 AM"` as minutes since midnight, or null when not a valid 12-hour time. */
export function parsePickupTime(value: unknown): number | null {
    if (typeof value !== 'string') {
        return null;
    }
    const match = TIME_PATTERN.exec(value);
    if (!match) {
        return null;
    }
    const hour = Number(match[1]) % 12;
    const minutes = Number(match[2]);
    return (hour + (match[3] === 'PM' ? 12 : 0)) * 60 + minutes;
}

/**
 * Error text for one `from` or `to` value, or nothing when it is well formed.
 * An empty value passes here: whether the window may be empty is decided by
 * the slot-level check, which sees both ends together.
 */
export function validatePickupTime(value: unknown): string | undefined {
    if (value == null || value === '') {
        return undefined;
    }
    return parsePickupTime(value) == null ? PICKUP_TIME_FORMAT_ERROR : undefined;
}

/**
 * Error text for a whole window, or nothing when it is acceptable. Empty in
 * either form (null, or both ends empty) is acceptable and means "no window".
 */
export function validatePickupSlot(value: unknown): string | undefined {
    const slot = value as Partial<PickupSlot> | null | undefined;
    if (slot == null || (!slot.from && !slot.to)) {
        return undefined;
    }
    if (!slot.from || !slot.to) {
        return PICKUP_SLOT_INCOMPLETE_ERROR;
    }
    const from = parsePickupTime(slot.from);
    const to = parsePickupTime(slot.to);
    if (from == null || to == null) {
        return PICKUP_TIME_FORMAT_ERROR;
    }
    if (to <= from) {
        return PICKUP_SLOT_ORDER_ERROR;
    }
    return undefined;
}

/** The window configured on a shipping method, or null when it has none or it is malformed. */
export function pickupSlotOf(method: ShippingMethod | null | undefined): PickupSlot | null {
    const slot = method?.customFields?.pickupSlot;
    if (!isPickupSlotSet(slot) || validatePickupSlot(slot)) {
        return null;
    }
    return { from: slot.from, to: slot.to };
}

/** `"10:00 AM - 12:00 PM"`, the form used in messages and on the admin order page. */
export function formatPickupSlot(slot: PickupSlot): string {
    return `${slot.from} - ${slot.to}`;
}

/** Minutes since midnight → `"h:mm AM"`, the same text form the admin dropdowns produce. */
export function formatPickupMinutes(minutes: number): string {
    const hour24 = Math.floor(minutes / 60) % 24;
    const hour12 = hour24 % 12 || 12;
    const mm = String(minutes % 60).padStart(2, '0');
    return `${hour12}:${mm} ${hour24 < 12 ? 'AM' : 'PM'}`;
}

/** Whether a customer's time falls inside the hours, ends included. */
export function isWithinPickupSlot(time: unknown, slot: PickupSlot): boolean {
    const chosen = parsePickupTime(time);
    const from = parsePickupTime(slot.from);
    const to = parsePickupTime(slot.to);
    return chosen != null && from != null && to != null && from <= chosen && chosen <= to;
}

/**
 * The times a customer may choose for the hours, from the start to the end
 * in PICKUP_TIME_STEP_MINUTES steps. The app builds the same list from the
 * hours it reads on the shipping method; this is the server's reference.
 */
export function pickupTimeOptions(slot: PickupSlot, stepMinutes = PICKUP_TIME_STEP_MINUTES): string[] {
    const from = parsePickupTime(slot.from);
    const to = parsePickupTime(slot.to);
    if (from == null || to == null || to < from) {
        return [];
    }
    const options: string[] = [];
    for (let minutes = from; minutes <= to; minutes += stepMinutes) {
        options.push(formatPickupMinutes(minutes));
    }
    return options;
}
