/**
 * Parses a shipping method's "Order Notification Numbers" custom field
 * (comma / semicolon / newline-separated) into bare 10-digit Indian mobile
 * numbers, the format SmsService expects (it adds +91 itself). Accepts numbers
 * typed with +91 / 91 / a leading 0 and dedupes; anything that does not reduce
 * to 10 digits is dropped, so one bad entry never blocks the other sends.
 */
export function parseNotificationPhones(raw: string | null | undefined): string[] {
    if (!raw) {
        return [];
    }
    const result: string[] = [];
    for (const part of raw.split(/[,;\n]/)) {
        let digits = part.replace(/\D/g, '').replace(/^0+/, '');
        if (digits.length === 12 && digits.startsWith('91')) {
            digits = digits.slice(2);
        }
        if (digits.length === 10 && !result.includes(digits)) {
            result.push(digits);
        }
    }
    return result;
}
