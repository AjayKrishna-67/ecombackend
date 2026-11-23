import { describe, expect, it } from 'vitest';
import { DEFAULT_CANCEL_ORDER_ALERT_CONFIG } from '../constants';
import { resolveAlertConfig, sanitizeIds, sanitizeNumbers } from './resolve-alert-config';

describe('sanitizeNumbers', () => {
    it('normalises, drops blanks and de-dupes', () => {
        const actual = sanitizeNumbers(['6380774767', '  ', '+91 63807 74767', '916379993190']);

        expect(actual).toEqual(['916380774767', '916379993190']);
    });
});

describe('recipient de-duplication', () => {
    it('messages a number once when it is both an admin phone and a typed number', () => {
        // Mirrors Msg91Service.sendOrderCancellationWhatsapp: admin phones unioned with the
        // layer's ad-hoc numbers. Picking an admin AND typing their number is redundant, not
        // a double send.
        const adminPhones = ['919791300108'];
        const config = resolveAlertConfig({ channel: { supportNumbers: ['9791300108'] } });

        const actual = Array.from(new Set([...adminPhones, ...config.supportNumbers]));

        expect(actual).toEqual(['919791300108']);
    });
});

describe('sanitizeIds', () => {
    it('stringifies, drops blanks and de-dupes', () => {
        const actual = sanitizeIds([44, '44', ' 45 ', '']);

        expect(actual).toEqual(['44', '45']);
    });
});

describe('resolveAlertConfig', () => {
    it('falls back to the seed defaults when no layer is set', () => {
        const actual = resolveAlertConfig({});

        expect(actual).toEqual(DEFAULT_CANCEL_ORDER_ALERT_CONFIG);
    });

    it('prefers env vars over the seed defaults', () => {
        const actual = resolveAlertConfig({
            env: { helloNumber: '911111111111', supportNumbers: '912222222222,913333333333' },
        });

        expect(actual).toEqual({
            helloNumber: '911111111111',
            supportNumbers: ['912222222222', '913333333333'],
            adminIds: [],
        });
    });

    it('prefers the shared default layer over env vars', () => {
        const actual = resolveAlertConfig({
            global: { supportNumbers: ['919999999999'] },
            env: { supportNumbers: '912222222222' },
        });

        expect(actual.supportNumbers).toEqual(['919999999999']);
    });

    it('prefers the channel layer over the shared default layer', () => {
        const actual = resolveAlertConfig({
            channel: { supportNumbers: ['918888888888'] },
            global: { supportNumbers: ['919999999999'] },
        });

        expect(actual.supportNumbers).toEqual(['918888888888']);
    });

    it('counts a layer as set when it only names administrators', () => {
        const actual = resolveAlertConfig({
            channel: { adminIds: ['44'] },
            global: { supportNumbers: ['919999999999'] },
        });

        // The channel layer wins WHOLE: its admins are used and the default numbers are NOT
        // merged in, otherwise picking one admin would silently keep messaging everyone else.
        expect(actual.adminIds).toEqual(['44']);
        expect(actual.supportNumbers).toEqual([]);
    });

    it('carries admins and ad-hoc numbers together from the winning layer', () => {
        const actual = resolveAlertConfig({
            channel: { adminIds: ['44', '45'], supportNumbers: ['918888888888'] },
        });

        expect(actual.adminIds).toEqual(['44', '45']);
        expect(actual.supportNumbers).toEqual(['918888888888']);
    });

    it('uses the shared default layer when the channel layer is entirely empty', () => {
        const actual = resolveAlertConfig({
            channel: { adminIds: [], supportNumbers: [] },
            global: { adminIds: ['44'], supportNumbers: ['919999999999'] },
        });

        expect(actual.adminIds).toEqual(['44']);
        expect(actual.supportNumbers).toEqual(['919999999999']);
    });

    it('resolves the sender number independently of the recipient layers', () => {
        const actual = resolveAlertConfig({
            channel: { supportNumbers: ['918888888888'] },
            global: { helloNumber: '917777777777', supportNumbers: ['919999999999'] },
        });

        expect(actual.helloNumber).toEqual('917777777777');
    });

    it('prefixes bare 10-digit numbers with the country code', () => {
        const actual = resolveAlertConfig({ channel: { supportNumbers: ['6380774767'] } });

        expect(actual.supportNumbers).toEqual(['916380774767']);
    });
});
