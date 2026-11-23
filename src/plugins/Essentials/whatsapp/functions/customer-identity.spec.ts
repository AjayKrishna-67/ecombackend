import { describe, expect, it } from 'vitest';

import { cleanProfileName, sharedOwnPhone, toIndianMobile } from './customer-identity';

describe('toIndianMobile', () => {
    it('strips the 91 country code from an Indian wa_id', () => {
        expect(toIndianMobile('918056305724')).toBe('8056305724');
    });

    it('rejects numbers from other countries', () => {
        expect(toIndianMobile('14155552671')).toBeNull();
        expect(toIndianMobile('447911123456')).toBeNull();
    });

    it('rejects malformed Indian numbers', () => {
        expect(toIndianMobile('91805630572')).toBeNull();
        expect(toIndianMobile('8056305724')).toBeNull();
    });
});

describe('sharedOwnPhone', () => {
    it('returns the phone the user shared through our contact-request button', () => {
        const inputMessage = {
            id: 'm1',
            type: 'contacts',
            contacts: [{ origin: 'contact_request', phones: [{ wa_id: '918056305724' }] }],
        };
        expect(sharedOwnPhone(inputMessage)).toBe('918056305724');
    });

    it('ignores an ordinary contact card, which could be anyone', () => {
        const inputMessage = {
            id: 'm2',
            type: 'contacts',
            contacts: [{ phones: [{ wa_id: '919000000001' }] }],
        };
        expect(sharedOwnPhone(inputMessage)).toBeUndefined();
    });

    it('ignores non-contact messages', () => {
        expect(sharedOwnPhone({ id: 'm3', type: 'text', text: { body: 'Hi' } })).toBeUndefined();
    });
});

describe('cleanProfileName', () => {
    it('drops emoji and symbols but keeps letters in any script', () => {
        expect(cleanProfileName('Sriram 🔥✨')).toBe('Sriram');
        expect(cleanProfileName('ஸ்ரீராம்')).toBe('ஸ்ரீராம்');
        expect(cleanProfileName("D'Souza-Rao J.")).toBe("D'Souza-Rao J.");
    });

    it('returns an empty string when nothing usable is left', () => {
        expect(cleanProfileName(undefined)).toBe('');
        expect(cleanProfileName('🔥🔥')).toBe('');
    });

    it('caps the length at 100 characters', () => {
        expect(cleanProfileName('a'.repeat(150))).toHaveLength(100);
    });

    it('drops a bare emoji with variation selector', () => {
        expect(cleanProfileName('❤️')).toBe('');
    });

    it('drops a trailing emoji with variation selector', () => {
        expect(cleanProfileName('Sriram ❤️')).toBe('Sriram');
    });

    it('drops the enclosing keycap mark but keeps the digit', () => {
        expect(cleanProfileName('Raj 1️⃣')).toBe('Raj 1');
    });

    it('normalises mathematical script letters to plain letters', () => {
        expect(cleanProfileName('𝓢𝓻𝓲𝓻𝓪𝓶')).toBe('Sriram');
    });

    it('normalises a curly apostrophe to a straight one', () => {
        expect(cleanProfileName('D’Souza')).toBe("D'Souza");
    });

    it('truncates by code point so a surrogate pair is never split', () => {
        const actualName = cleanProfileName('a'.repeat(99) + '𠀀𠀀');
        expect(Array.from(actualName)).toHaveLength(100);
        expect(actualName.endsWith('𠀀')).toBe(true);
    });
});
