import * as crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { findMatchingWebhookSecret } from './razorpay-utils';

/** Signs exactly the way Razorpay does: hex HMAC-SHA256 of the raw request body. */
function signLikeRazorpay(rawBody: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

const inputRawBody = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1","order_id":"order_1"}}}}';

describe('findMatchingWebhookSecret', () => {
    it('returns the index of the secret that signed the body, among several accounts', () => {
        const inputSecrets = ['account-one-secret', 'account-two-secret'];
        const actualIndex = findMatchingWebhookSecret(inputRawBody, signLikeRazorpay(inputRawBody, 'account-two-secret'), inputSecrets);
        expect(actualIndex).toBe(1);
    });

    it('returns -1 when no configured secret signed the body', () => {
        const actualIndex = findMatchingWebhookSecret(inputRawBody, signLikeRazorpay(inputRawBody, 'attacker-secret'), ['account-one-secret']);
        expect(actualIndex).toBe(-1);
    });

    it('returns -1 when the body was re-serialized after signing (raw bytes matter)', () => {
        const signature = signLikeRazorpay(inputRawBody, 'account-one-secret');
        const reStringified = JSON.stringify(JSON.parse(inputRawBody), null, 2);
        expect(findMatchingWebhookSecret(reStringified, signature, ['account-one-secret'])).toBe(-1);
    });

    it('returns -1 for an empty secret list (fail closed)', () => {
        expect(findMatchingWebhookSecret(inputRawBody, signLikeRazorpay(inputRawBody, 'x'), [])).toBe(-1);
    });

    it('returns -1 instead of throwing for an empty or wrong-length signature', () => {
        expect(findMatchingWebhookSecret(inputRawBody, '', ['account-one-secret'])).toBe(-1);
        expect(findMatchingWebhookSecret(inputRawBody, 'abc', ['account-one-secret'])).toBe(-1);
    });
});
