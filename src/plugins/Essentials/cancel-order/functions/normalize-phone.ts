/**
 * Normalises a phone number into the MSG91 / WhatsApp format: digits only, with the Indian
 * country code (91). MSG91 silently drops recipients without a country code, so a bare
 * 10-digit number must be prefixed. Strips +, spaces, dashes and leading zeroes. Numbers that
 * already carry a country code are returned digits-only as a best effort.
 */
export function normalizePhone(raw: string): string {
    const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length === 10) {
        return `91${digits}`;
    }
    return digits;
}
