import { Logger } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RazorpaySettleQueueService } from './razorpay-settle-queue.service';

type ProcessFn = (job: { data: { eventId: string } }) => Promise<void>;

function buildEvent(overrides: Record<string, unknown> = {}): any {
    return {
        eventId: 'evt_1',
        status: 'received',
        signature: 'sig',
        signatureValid: false,
        rawPayload: '{"event":"payment.captured","payload":{}}',
        processedAt: null,
        error: null,
        ...overrides,
    };
}

/**
 * Drives the real queue entry point: onModuleInit registers the process function
 * with the JobQueueService, and the test invokes that function as the worker would.
 */
async function buildQueue(event: any, processWebhook: () => Promise<unknown>) {
    let processJob: ProcessFn | undefined;
    const jobQueueService: any = {
        createQueue: async (options: { process: ProcessFn }) => {
            processJob = options.process;
            return { add: async () => undefined };
        },
    };
    const saved: any[] = [];
    const connection: any = {
        getRepository: () => ({
            findOne: async () => event,
            save: async (entity: any) => saved.push({ ...entity }),
        }),
    };
    const requestContextService: any = { create: async () => ({}) };
    const webhookService: any = { processWebhook: vi.fn(processWebhook) };
    const queue = new RazorpaySettleQueueService(jobQueueService, connection, requestContextService, webhookService);
    await queue.onModuleInit();
    const run = () => (processJob as ProcessFn)({ data: { eventId: event.eventId } });
    return { run, saved, webhookService };
}

describe('RazorpaySettleQueueService job processing', () => {
    beforeEach(() => {
        vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("stores a refused signature as 'rejected' without throwing, so the job is not retried", async () => {
        const { run, saved } = await buildQueue(buildEvent(), async () => 'invalid-signature');
        await expect(run()).resolves.toBeUndefined();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ status: 'rejected', signatureValid: false, error: 'invalid signature' });
    });

    it("marks a verified, handled event 'processed' with signatureValid=true", async () => {
        const { run, saved } = await buildQueue(buildEvent(), async () => 'processed');
        await run();
        expect(saved[0]).toMatchObject({ status: 'processed', signatureValid: true, error: null });
    });

    it("still marks other failures 'failed' and rethrows for the JobQueue retry", async () => {
        const { run, saved } = await buildQueue(buildEvent(), async () => {
            throw new Error('MONEY_STUCK: test');
        });
        await expect(run()).rejects.toThrow('MONEY_STUCK: test');
        expect(saved[0]).toMatchObject({ status: 'failed', error: 'MONEY_STUCK: test' });
    });

    it.each(['processed', 'ignored'])("skips an event already '%s'", async status => {
        const { run, webhookService } = await buildQueue(buildEvent({ status }), async () => 'processed');
        await run();
        expect(webhookService.processWebhook).not.toHaveBeenCalled();
    });

    it("re-runs a 'rejected' event once it is re-enqueued (after a secret fix)", async () => {
        const { run, saved, webhookService } = await buildQueue(buildEvent({ status: 'rejected' }), async () => 'processed');
        await run();
        expect(webhookService.processWebhook).toHaveBeenCalledOnce();
        expect(saved[0]).toMatchObject({ status: 'processed', signatureValid: true });
    });
});
