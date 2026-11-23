// src/plugins/Payment/Razorpay/types.ts

// 1. Export the constant string so we can use it in the service

export const RAZORPAY_WEBHOOK_TYPE = 'RAZORPAY_WEBHOOK';

/** Result of RazorpayWebhookService.processWebhook, recorded by the settle queue. */
export type RazorpayWebhookOutcome = 'processed' | 'invalid-signature';

/**
 * What Razorpay says about money for one Razorpay order (the ONLY input to a revert):
 * - 'paid'        a captured/authorized payment exists, or the Razorpay order is paid
 * - 'in-progress' an attempt is still `created` (customer is in the UPI app / on the
 *                 bank page) and younger than the pending-attempt window
 * - 'unpaid'      nothing paid and nothing in flight: safe to revert to AddingItems
 * - 'unknown'     Razorpay could not be asked: never revert
 */
export type RazorpayPaymentActivity = 'paid' | 'in-progress' | 'unpaid' | 'unknown';

// 2. Augment the @vendure/core module

declare module '@vendure/core' {

    // We are adding to the existing OrderHistoryEntryData interface

    interface OrderHistoryEntryData {

        [RAZORPAY_WEBHOOK_TYPE]: {

            webhookEvent: string;

            source: string;

            timestamp: string;

            paymentId: string;

            razorpayOrderId: string;

            amount: number;

            status: string;

        };

    }

}

