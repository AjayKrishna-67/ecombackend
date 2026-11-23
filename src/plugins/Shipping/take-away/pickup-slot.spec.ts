import { describe, expect, it } from 'vitest';

import {
    formatPickupMinutes,
    formatPickupSlot,
    isPickupSlotSet,
    isWithinPickupSlot,
    parsePickupTime,
    PICKUP_SLOT_INCOMPLETE_ERROR,
    PICKUP_SLOT_ORDER_ERROR,
    PICKUP_TIME_FORMAT_ERROR,
    pickupSlotOf,
    pickupTimeOptions,
    validatePickupSlot,
    validatePickupTime,
} from './pickup-slot';

const slot = (from: string, to: string) => ({ from, to });

describe('parsePickupTime', () => {
    it('reads a 12-hour time as minutes since midnight', () => {
        expect(parsePickupTime('10:00 AM')).toBe(600);
        expect(parsePickupTime('12:30 PM')).toBe(750);
        expect(parsePickupTime('12:00 AM')).toBe(0);
        expect(parsePickupTime('9:15 PM')).toBe(21 * 60 + 15);
    });

    it('tolerates a leading zero on the hour', () => {
        expect(parsePickupTime('09:00 AM')).toBe(540);
    });

    it('rejects anything that is not h:mm AM or h:mm PM', () => {
        for (const bad of ['10:00', '10:00am', '10:00  AM', '13:00 PM', '0:30 AM', '10:60 AM', '', 10, null]) {
            expect(parsePickupTime(bad)).toBeNull();
        }
    });
});

describe('validatePickupTime', () => {
    it('is silent for a well-formed time', () => {
        expect(validatePickupTime('4:00 PM')).toBeUndefined();
    });

    it('returns the format message otherwise', () => {
        expect(validatePickupTime('4pm')).toBe(PICKUP_TIME_FORMAT_ERROR);
    });

    it('lets an empty value through, leaving emptiness to the window-level check', () => {
        expect(validatePickupTime(null)).toBeUndefined();
        expect(validatePickupTime('')).toBeUndefined();
    });
});

describe('isPickupSlotSet', () => {
    it('is true only when both ends are filled', () => {
        expect(isPickupSlotSet(slot('10:00 AM', '12:00 PM'))).toBe(true);
        expect(isPickupSlotSet({ from: null, to: null } as any)).toBe(false);
        expect(isPickupSlotSet({ from: '10:00 AM', to: '' })).toBe(false);
        expect(isPickupSlotSet(null)).toBe(false);
        expect(isPickupSlotSet(undefined)).toBe(false);
    });
});

describe('validatePickupSlot', () => {
    it('accepts no window, in either empty form', () => {
        expect(validatePickupSlot(null)).toBeUndefined();
        expect(validatePickupSlot(undefined)).toBeUndefined();
        expect(validatePickupSlot({ from: null, to: null })).toBeUndefined();
        expect(validatePickupSlot({ from: '', to: '' })).toBeUndefined();
    });

    it('accepts a well-formed window that ends after it starts', () => {
        expect(validatePickupSlot(slot('10:00 AM', '12:00 PM'))).toBeUndefined();
        expect(validatePickupSlot(slot('11:30 AM', '12:00 PM'))).toBeUndefined();
    });

    it('rejects a window with only one end set', () => {
        expect(validatePickupSlot({ from: '10:00 AM', to: null })).toBe(PICKUP_SLOT_INCOMPLETE_ERROR);
        expect(validatePickupSlot({ from: '', to: '12:00 PM' })).toBe(PICKUP_SLOT_INCOMPLETE_ERROR);
    });

    it('rejects a malformed time', () => {
        expect(validatePickupSlot(slot('10:00 AM', '12pm'))).toBe(PICKUP_TIME_FORMAT_ERROR);
    });

    it('rejects a window that ends before or when it starts', () => {
        expect(validatePickupSlot(slot('12:00 PM', '10:00 AM'))).toBe(PICKUP_SLOT_ORDER_ERROR);
        expect(validatePickupSlot(slot('10:00 AM', '10:00 AM'))).toBe(PICKUP_SLOT_ORDER_ERROR);
    });
});

describe('pickupSlotOf', () => {
    it('returns the window configured on the method', () => {
        const inputMethod = { customFields: { pickupSlot: slot('10:00 AM', '12:00 PM') } } as any;

        expect(pickupSlotOf(inputMethod)).toEqual(slot('10:00 AM', '12:00 PM'));
    });

    it('returns null for a method without a window, or with a broken one', () => {
        expect(pickupSlotOf({ customFields: {} } as any)).toBeNull();
        expect(pickupSlotOf({ customFields: { pickupSlot: { from: null, to: null } } } as any)).toBeNull();
        expect(pickupSlotOf({ customFields: { pickupSlot: slot('12:00 PM', '10:00 AM') } } as any)).toBeNull();
        expect(pickupSlotOf(undefined)).toBeNull();
    });
});

describe('formatPickupSlot', () => {
    it('joins the two ends with a dash', () => {
        expect(formatPickupSlot(slot('10:00 AM', '12:00 PM'))).toBe('10:00 AM - 12:00 PM');
    });
});

describe('formatPickupMinutes', () => {
    it('writes minutes since midnight in the h:mm AM form the dropdowns produce', () => {
        expect(formatPickupMinutes(0)).toBe('12:00 AM');
        expect(formatPickupMinutes(600)).toBe('10:00 AM');
        expect(formatPickupMinutes(750)).toBe('12:30 PM');
        expect(formatPickupMinutes(21 * 60 + 15)).toBe('9:15 PM');
    });
});

describe('isWithinPickupSlot', () => {
    const hours = slot('10:00 AM', '12:00 PM');

    it('accepts a time inside the hours, both ends included', () => {
        expect(isWithinPickupSlot('10:00 AM', hours)).toBe(true);
        expect(isWithinPickupSlot('10:30 AM', hours)).toBe(true);
        expect(isWithinPickupSlot('12:00 PM', hours)).toBe(true);
    });

    it('rejects a time outside the hours or malformed', () => {
        expect(isWithinPickupSlot('9:45 AM', hours)).toBe(false);
        expect(isWithinPickupSlot('12:15 PM', hours)).toBe(false);
        expect(isWithinPickupSlot('10am', hours)).toBe(false);
        expect(isWithinPickupSlot(null, hours)).toBe(false);
    });
});

describe('pickupTimeOptions', () => {
    it('lists quarter-hour times from the start to the end', () => {
        expect(pickupTimeOptions(slot('10:00 AM', '11:00 AM'))).toEqual([
            '10:00 AM',
            '10:15 AM',
            '10:30 AM',
            '10:45 AM',
            '11:00 AM',
        ]);
    });

    it('crosses noon correctly', () => {
        expect(pickupTimeOptions(slot('11:30 AM', '12:30 PM'), 30)).toEqual(['11:30 AM', '12:00 PM', '12:30 PM']);
    });

    it('is empty for broken hours', () => {
        expect(pickupTimeOptions(slot('12:00 PM', '10:00 AM'))).toEqual([]);
        expect(pickupTimeOptions(slot('x', '10:00 AM'))).toEqual([]);
    });
});
