import { Injectable, OnModuleInit } from '@nestjs/common';
import {
    JobQueue, JobQueueService, TransactionalConnection, RequestContextService, Logger,
} from '@vendure/core';
import { RazorpayWebhookEvent } from '../entities/razorpay-webhook-event.entity';
import { RazorpayWebhookService } from './razorpay-webhook.service';

interface SettleJobData {
    eventId: string;
}

/**
 * Owns the `razorpay-settle` job queue. The controller persists a raw webhook to
 * `RazorpayWebhookEvent` and enqueues its id; this queue drains it off the HTTP
 * thread. Processing is durable (JobQueue persists + retries) and idempotent
 * (keyed on the event row's status), so at-least-once webhook delivery is safe.
 */
@Injectable()
export class RazorpaySettleQueueService implements OnModuleInit {
    private queue: JobQueue<SettleJobData>;

    constructor(
        private jobQueueService: JobQueueService,
        private connection: TransactionalConnection,
        private requestContextService: RequestContextService,
        private webhookService: RazorpayWebhookService,
    ) {}

    async onModuleInit() {
        this.queue = await this.jobQueueService.createQueue({
            name: 'razorpay-settle',
            process: async job => {
                await this.processEvent(job.data.eventId);
            },
        });
    }

    /** Enqueue a persisted webhook event for async processing. */
    async enqueue(eventId: string): Promise<void> {
        await this.queue.add({ eventId }, { retries: 5 });
    }

    private async processEvent(eventId: string): Promise<void> {
        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        const repo = this.connection.getRepository(ctx, RazorpayWebhookEvent);
        const event = await repo.findOne({ where: { eventId } });
        if (!event) {
            Logger.warn(`[SettleQueue] Event ${eventId} not found; nothing to process.`, 'RazorpayPlugin');
            return;
        }
        // 'rejected' is deliberately NOT skipped: once a missing or rotated secret is
        // fixed, re-enqueueing the event id runs it again.
        if (event.status === 'processed' || event.status === 'ignored') {
            return; // idempotent: already handled
        }
        try {
            const body = JSON.parse(event.rawPayload);
            // processWebhook verifies the signature over the stored raw bytes first,
            // then routes (settlement / QR / payment-link / failure).
            const outcome = await this.webhookService.processWebhook(event.signature || '', body, event.rawPayload);
            // A bad signature is final for this attempt: retrying cannot change the
            // HMAC, so record it without throwing (no JobQueue retry).
            const isRejected = outcome === 'invalid-signature';
            event.status = isRejected ? 'rejected' : 'processed';
            event.signatureValid = !isRejected;
            event.processedAt = new Date();
            event.error = isRejected ? 'invalid signature' : null;
            await repo.save(event);
        } catch (e: any) {
            event.status = 'failed';
            event.processedAt = new Date();
            event.error = (e?.message || String(e)).slice(0, 1000);
            await repo.save(event);
            throw e; // surface to JobQueue for retry/backoff
        }
    }
}
