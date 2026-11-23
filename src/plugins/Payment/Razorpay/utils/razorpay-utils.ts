import Razorpay from "razorpay";
import * as crypto from "crypto";

export function getRazorpayInstance(args: { key_id: string; key_secret: string }) {
    return new Razorpay({
        key_id: args.key_id,
        key_secret: args.key_secret,
    });
}

// 1. Frontend Checkout Signature Verification (Keep this)
export function isChecksumVerified({
    razorpaySignature,
    razorpayOrderId,
    razorpayPaymentId,
    secretKey,
}: {
    razorpaySignature: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    secretKey: string;
}): boolean {
    const hmac = crypto.createHmac("sha256", secretKey);
    hmac.update(razorpayOrderId + "|" + razorpayPaymentId);
    const generatedSignature = hmac.digest("hex");
    return generatedSignature === razorpaySignature;
}

/**
 * 2. Webhook signature check. Returns the index of the secret whose HMAC-SHA256 over
 * the raw request bytes equals `signature`, or -1. Any configured secret may match:
 * there are two Razorpay accounts, and a rotation briefly has old and new secrets.
 * Compared in constant time; timingSafeEqual throws on unequal lengths, so the
 * length is checked first.
 */
export function findMatchingWebhookSecret(
    rawBody: string,
    signature: string,
    secrets: readonly string[],
): number {
    const received = Buffer.from(signature || '', 'utf8');
    return secrets.findIndex(secret => {
        const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
        return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    });
}

/**
 * Fetch QR code status directly from Razorpay REST API.
 * Bypasses the Razorpay SDK's qrCode.fetch() which has a bug in v2.9.6
 * where it returns "QR Code Id provided doesn't exist" for valid QR codes.
 */
export async function fetchQrCodeStatus(
    qrCodeId: string,
    keyId: string,
    keySecret: string,
): Promise<any> {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const response = await fetch(`https://api.razorpay.com/v1/payments/qr_codes/${qrCodeId}`, {
        method: 'GET',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Razorpay QR fetch failed (HTTP ${response.status}): ${body}`);
    }
    return response.json();
}

export async function getPaymentAmountOnOrder(
    razorpayOrderId: string,
    razorpayClient: any
): Promise<number | boolean> {
    const payments = await razorpayClient.orders.fetchPayments(razorpayOrderId);
    if (Array.isArray(payments.items) || payments.items.length) {
        return +payments.items[0].amount;
    } else {
        return false;
    }
}