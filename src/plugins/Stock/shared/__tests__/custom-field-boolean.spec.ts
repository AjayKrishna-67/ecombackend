import { describe, expect, it } from 'vitest';

import { isCustomFieldTrue } from '../custom-field-boolean';

describe('isCustomFieldTrue', () => {
    // The regression this exists for: MySQL stores boolean custom fields as
    // tinyint, so an enabled flag arrives as the NUMBER 1. `1 === true` is
    // false, which read every enabled weight pool as disabled.
    it('treats the number 1 as true (the MySQL tinyint case)', () => {
        expect(isCustomFieldTrue(1)).toBe(true);
    });

    it('treats a real boolean true as true', () => {
        expect(isCustomFieldTrue(true)).toBe(true);
    });

    it('treats 0 and false as false', () => {
        expect(isCustomFieldTrue(0)).toBe(false);
        expect(isCustomFieldTrue(false)).toBe(false);
    });

    it('treats an unset field as false', () => {
        expect(isCustomFieldTrue(null)).toBe(false);
        expect(isCustomFieldTrue(undefined)).toBe(false);
    });

    // CSV round-trips turn everything into strings.
    it('handles string forms', () => {
        expect(isCustomFieldTrue('1')).toBe(true);
        expect(isCustomFieldTrue('true')).toBe(true);
        expect(isCustomFieldTrue('TRUE')).toBe(true);
        expect(isCustomFieldTrue('yes')).toBe(true);
        expect(isCustomFieldTrue('0')).toBe(false);
        expect(isCustomFieldTrue('false')).toBe(false);
        expect(isCustomFieldTrue('')).toBe(false);
    });

    // Why this is not Boolean(value): the string '0' is truthy in JS, and a
    // spreadsheet export writing "0" must not switch a weight pool on.
    it("does NOT treat the string '0' as true, unlike Boolean()", () => {
        expect(Boolean('0')).toBe(true);
        expect(isCustomFieldTrue('0')).toBe(false);
    });
});
