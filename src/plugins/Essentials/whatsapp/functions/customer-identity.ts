import { CONTACT_REQUEST_ORIGIN } from '../constants';
import { WhatsappIncomingMessage } from '../types';

const INDIAN_WA_ID = /^91(\d{10})$/;
const MAX_NAME_LENGTH = 100;

/**
 * Converts a WhatsApp wa_id (always E.164 digits, e.g. "918056305724") to the
 * bare 10-digit mobile stored in customer.phoneNumber. Returns null for any
 * non-Indian or malformed number — those customers get a plain store link.
 */
export function toIndianMobile(waId: string): string | null {
    return INDIAN_WA_ID.exec(waId)?.[1] ?? null;
}

/**
 * The customer's own phone from a `contacts` message — but only when it came
 * from our REQUEST_CONTACT_INFO button. An ordinary shared contact card can be
 * anyone's number and must never be used to log someone in.
 */
export function sharedOwnPhone(message: WhatsappIncomingMessage): string | undefined {
    if (message.type !== 'contacts') {
        return undefined;
    }
    const ownContact = message.contacts?.find(contact => contact.origin === CONTACT_REQUEST_ORIGIN);
    return ownContact?.phones?.[0]?.wa_id;
}

const CURLY_APOSTROPHES = /[\u2018\u2019\u02BC]/g;
const UNICODE_HYPHENS = /[\u2010\u2011]/g;
const INVISIBLE_JOINERS = /[\u200C\u200D]/g;
const EMOJI_PRESENTATION_MARKS = /\p{Variation_Selector}|\p{Me}/gu;
const DISALLOWED_NAME_CHARS = /[^\p{L}\p{M}\p{N} .'-]/gu;

/**
 * WhatsApp profile names are free text chosen by the user (often with emoji
 * or "fancy font" letters). NFKC first folds those decorative letterforms
 * (e.g. mathematical script "𝓢𝓻𝓲𝓻𝓪𝓶") down to plain ones. Then emoji
 * variation selectors (U+FE0F) and enclosing marks like the keycap
 * combiner (U+20E3) are stripped explicitly, because both fall under
 * \p{M} and would otherwise survive as orphaned combining marks once the
 * emoji base character they modify is removed. Curly quotes/hyphens are
 * normalised to plain ASCII, everything else outside the allowed set is
 * dropped, and the 100-character cap is applied by code point (not UTF-16
 * unit) so a 4-byte character (e.g. an astral letter) is never split in half.
 */
export function cleanProfileName(raw: string | undefined): string {
    if (!raw) {
        return '';
    }
    const cleaned = raw
        .normalize('NFKC')
        .replace(CURLY_APOSTROPHES, "'")
        .replace(UNICODE_HYPHENS, '-')
        .replace(INVISIBLE_JOINERS, '')
        .replace(EMOJI_PRESENTATION_MARKS, '')
        .replace(DISALLOWED_NAME_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Slice by code point, not UTF-16 unit, so a 4-byte character is never cut in half.
    return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
}
