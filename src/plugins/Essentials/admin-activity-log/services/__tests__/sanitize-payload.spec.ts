import { describe, expect, it } from 'vitest';
import { ADMIN_ACTIVITY_LOG_CONFIG } from '../../constants';
import { sanitizePayload } from '../sanitize-payload';

const { REDACTED_PLACEHOLDER, DEPTH_TRUNCATION_MARKER, MAX_PAYLOAD_BYTES, MAX_STRING_LENGTH } =
    ADMIN_ACTIVITY_LOG_CONFIG;

/**
 * These are the tests that matter most in the plugin.
 *
 * Auditing works by persisting raw mutation arguments, and several admin
 * mutations carry plaintext credentials — `createAdministrator` takes a
 * password, the OTP strategies take codes. A regression here would write those
 * into a table that every audit reader can query, which is a worse hole than the
 * one this plugin exists to close.
 */
describe('sanitizePayload', () => {
    describe('credential redaction', () => {
        it('redacts a plaintext administrator password', () => {
            const input = {
                input: { emailAddress: 'a@b.com', password: 'hunter2', firstName: 'Sri' },
            };

            const actual = sanitizePayload(input) as any;

            expect(actual.input.password).toBe(REDACTED_PLACEHOLDER);
            expect(JSON.stringify(actual)).not.toContain('hunter2');
        });

        it('matches credential keys by substring, not by exact name', () => {
            const input = {
                input: {
                    currentPassword: 'old-one',
                    newPassword: 'new-one',
                    passwordConfirmation: 'new-one',
                },
            };

            const actual = sanitizePayload(input) as any;

            expect(Object.values(actual.input)).toEqual([
                REDACTED_PLACEHOLDER,
                REDACTED_PLACEHOLDER,
                REDACTED_PLACEHOLDER,
            ]);
        });

        it('matches credential keys case-insensitively', () => {
            const actual = sanitizePayload({ APIKey: 'abc', Authorization: 'Bearer x' }) as any;

            expect(actual.APIKey).toBe(REDACTED_PLACEHOLDER);
            expect(actual.Authorization).toBe(REDACTED_PLACEHOLDER);
        });

        it('redacts an OTP and a token wherever they are nested', () => {
            const input = { input: { user: { otp: '482913', refreshToken: 'aaa.bbb.ccc' } } };

            const actual = sanitizePayload(input) as any;

            expect(actual.input.user.otp).toBe(REDACTED_PLACEHOLDER);
            expect(actual.input.user.refreshToken).toBe(REDACTED_PLACEHOLDER);
        });

        it('redacts the whole subtree under a credential key, not just scalars', () => {
            const input = { credentials: { password: 'a', recoveryCodes: ['x', 'y'] } };

            const actual = sanitizePayload(input) as any;

            expect(actual.credentials).toBe(REDACTED_PLACEHOLDER);
        });
    });

    describe('size bounds', () => {
        it('keeps a payload that fits, unchanged in shape', () => {
            const input = { input: { id: 731, enabled: true } };

            expect(sanitizePayload(input)).toEqual({ input: { id: 731, enabled: true } });
        });

        /**
         * Uses many KEYS rather than a long array or string, because the array
         * and string caps fire first and would keep the payload small. Only a
         * wide object — a settings blob, a bulk custom-field write — reaches the
         * byte cap in practice.
         */
        it('replaces an oversized payload with a preview marker', () => {
            const wide = Object.fromEntries(
                Array.from({ length: 200 }, (_, i) => [`field${i}`, 'x'.repeat(MAX_STRING_LENGTH)]),
            );

            const actual = sanitizePayload(wide) as any;

            expect(actual._truncated).toBe(true);
            expect(Buffer.byteLength(actual._preview, 'utf8')).toBeLessThanOrEqual(
                MAX_PAYLOAD_BYTES,
            );
        });

        it('caps arrays before the byte cap, so a long list stays diffable', () => {
            const input = { input: { rows: Array.from({ length: 5_000 }, (_, i) => ({ i })) } };

            const actual = sanitizePayload(input) as any;

            expect(actual._truncated).toBeUndefined();
            expect(actual.input.rows).toHaveLength(ADMIN_ACTIVITY_LOG_CONFIG.MAX_ARRAY_LENGTH + 1);
        });

        it('truncates a long string and records how much was dropped', () => {
            const actual = sanitizePayload({ description: 'x'.repeat(MAX_STRING_LENGTH + 50) }) as any;

            expect(actual.description).toContain(`+50 chars`);
            expect(actual.description.length).toBeLessThan(MAX_STRING_LENGTH + 50);
        });

        it('caps a long array and records the remainder', () => {
            const actual = sanitizePayload({ ids: Array.from({ length: 30 }, (_, i) => i) }) as any;

            expect(actual.ids).toHaveLength(ADMIN_ACTIVITY_LOG_CONFIG.MAX_ARRAY_LENGTH + 1);
            expect(actual.ids.at(-1)).toBe('…[+10 more]');
        });
    });

    describe('nesting depth', () => {
        /**
         * The regression this locks down: at a depth of four, a translated custom
         * field on a product arrived as `[TRUNCATED_DEPTH]`, so the value was lost
         * AND two different values compared equal in the diff — a real edit was
         * reported as no change.
         */
        it('keeps a translated custom field, which sits at depth five', () => {
            const productInput = {
                input: {
                    id: 731,
                    translations: [
                        { languageCode: 'ta', customFields: { localName: 'வெண்ணெய்' } },
                    ],
                },
            };

            const actual = sanitizePayload(productInput) as any;

            expect(actual.input.translations[0].customFields.localName).toBe('வெண்ணெய்');
        });

        it('still marks values nested past the limit', () => {
            const tooDeep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };

            const actual = sanitizePayload(tooDeep) as any;

            expect(actual.a.b.c.d.e.f.g).toBe(DEPTH_TRUNCATION_MARKER);
        });
    });

    describe('robustness', () => {
        it('never throws on a circular structure', () => {
            const circular: Record<string, unknown> = { name: 'loop' };
            circular.self = circular;

            expect(() => sanitizePayload(circular)).not.toThrow();
        });

        it('returns null for arguments that are not an object', () => {
            expect(sanitizePayload(null)).toBeNull();
            expect(sanitizePayload(undefined)).toBeNull();
            expect(sanitizePayload('a string')).toBeNull();
        });

        it('normalises undefined values to null so the JSON column round-trips', () => {
            const actual = sanitizePayload({ a: undefined, b: 1 }) as any;

            expect(actual.a).toBeNull();
            expect(actual.b).toBe(1);
        });

        it('serialises dates rather than dropping them', () => {
            const actual = sanitizePayload({ when: new Date('2026-08-14T10:00:00.000Z') }) as any;

            expect(actual.when).toBe('2026-08-14T10:00:00.000Z');
        });
    });
});
