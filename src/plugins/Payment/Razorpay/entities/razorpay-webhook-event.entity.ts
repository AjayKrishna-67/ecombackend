import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * Durable log of every Razorpay webhook we receive.
 *
 * Purpose:
 * - Idempotency as a DB uniqueness guarantee (`eventId`), not a Redis TTL that
 *   can evict and let a duplicate reprocess.
 * - Store the exact raw bytes so a stranded order can be replayed/audited.
 * - Decouple receipt from processing: the controller persists + returns 202,
 *   a worker job drains `received` rows through the SettlementService.
 *
 * Not channel-aware: the channel is resolved from the correlated order at
 * settlement time (a webhook payload has no channel of its own).
 */
@Entity()
export class RazorpayWebhookEvent extends VendureEntity {
    constructor(input?: DeepPartial<RazorpayWebhookEvent>) {
        super(input);
    }

    /**
     * Idempotency key. Prefers Razorpay's `x-razorpay-event-id` header (unique
     * per event); the controller supplies a deterministic fallback when absent.
     */
    @Index({ unique: true })
    @Column()
    eventId: string;

    /** Razorpay event name, e.g. `payment.captured`, `order.paid`, `payment.failed`. */
    @Column()
    event: string;

    @Index()
    @Column({ nullable: true })
    rzpOrderId: string;

    @Column({ nullable: true })
    rzpPaymentId: string;

    /** Exact raw request bytes, as received (used for signature audit + replay). */
    @Column({ type: 'text' })
    rawPayload: string;

    /** The `x-razorpay-signature` header, stored so the worker can verify later. */
    @Column({ type: 'text', nullable: true })
    signature: string | null;

    /** Whether the HMAC signature verified against the raw body (set from the real check). */
    @Column({ default: false })
    signatureValid: boolean;

    /**
     * Drain state: received | processed | failed | ignored | rejected.
     * 'rejected' = failed the signature check; can be re-enqueued after a secret fix
     * ('processed' and 'ignored' are final).
     */
    @Index()
    @Column({ default: 'received' })
    status: string;

    @Column({ type: 'datetime', nullable: true })
    processedAt: Date | null;

    @Column({ type: 'text', nullable: true })
    error: string | null;
}
