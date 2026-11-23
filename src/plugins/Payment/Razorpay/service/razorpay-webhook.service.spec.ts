import * as crypto from 'crypto';
import { Logger, PaymentMethod } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RazorpayWebhookService } from './razorpay-webhook.service';

function methodWithConfig(config: Record<string, unknown>): any {
    return { enabled: true, handler: { args: [{ name: 'config', value: JSON.stringify(config) }] } };
}

const ACCOUNT_ONE_SECRET = 'account-one-webhook-secret';
const ACCOUNT_TWO_SECRET = 'account-two-webhook-secret';

/** Six methods across two Razorpay accounts, like production: one without a secret, one disabled. */
const configuredMethods = [
    methodWithConfig({ key_id: 'rzp_live_one', key_secret: 'k1', webhook_secret: ACCOUNT_ONE_SECRET }),
    methodWithConfig({ key_id: 'rzp_live_one', key_secret: 'k1', webhook_secret: ACCOUNT_ONE_SECRET }),
    methodWithConfig({ key_id: 'rzp_live_two', key_secret: 'k2', webhook_enabled: false }),
    { ...methodWithConfig({ key_id: 'rzp_live_two', key_secret: 'k2', webhook_secret: ACCOUNT_TWO_SECRET }), enabled: false },
];

function signLikeRazorpay(rawBody: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Only PaymentMethod may be read before the signature is accepted. Any other
 * repository (Order, Fulfillment) and any settlement/order/history call fails the
 * test, which is how "no side effects on a refused webhook" is asserted.
 */
function buildService(methods: any[]) {
    const touchedEntities: string[] = [];
    const connection: any = {
        getRepository: (_ctx: unknown, entity: any) => {
            if (entity === PaymentMethod) {
                return { find: async () => methods };
            }
            touchedEntities.push(typeof entity === 'string' ? entity : entity?.name);
            return { findOne: async () => null, createQueryBuilder: () => { throw new Error('routing reached'); } };
        },
    };
    const forbidden = () => {
        throw new Error('side effect on an unverified webhook');
    };
    const orderService: any = { updateCustomFields: forbidden, transitionToState: forbidden, getNextOrderStates: forbidden };
    const historyService: any = { createHistoryEntryForOrder: forbidden };
    const fulfillmentService: any = { transitionToState: forbidden };
    const settlementService: any = { settleFromRazorpay: forbidden, resolveChannelContext: forbidden, getRazorpayClientForCtx: forbidden };
    const requestContextService: any = { create: async () => ({}) };
    const service = new RazorpayWebhookService(
        connection, orderService, requestContextService, historyService, fulfillmentService, settlementService,
    );
    return { service, touchedEntities };
}

function webhookBody(event: string): { body: any; rawBody: string } {
    const body = {
        event,
        payload: {
            payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 25000, notes: {} } },
            qr_code: { entity: { id: 'qr_1' } },
        },
    };
    return { body, rawBody: JSON.stringify(body) };
}

describe('RazorpayWebhookService.processWebhook signature door', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(['payment.failed', 'qr_code.credited', 'payment.captured'])(
        'refuses a forged %s before any routing or side effect',
        async event => {
            const { service, touchedEntities } = buildService(configuredMethods);
            const { body, rawBody } = webhookBody(event);
            const actual = await service.processWebhook(signLikeRazorpay(rawBody, 'attacker-secret'), body, rawBody);
            expect(actual).toBe('invalid-signature');
            expect(touchedEntities).toEqual([]);
            expect(errorSpy).toHaveBeenCalledWith(`[WEBHOOK-SIGNATURE-INVALID] event=${event} rzpOrder=order_1`, 'RazorpayPlugin');
        },
    );

    it('fails closed when no razorpay-payment method has a webhook secret', async () => {
        const { service } = buildService([methodWithConfig({ key_id: 'k', key_secret: 's' })]);
        const { body, rawBody } = webhookBody('payment.captured');
        const actual = await service.processWebhook(signLikeRazorpay(rawBody, ACCOUNT_ONE_SECRET), body, rawBody);
        expect(actual).toBe('invalid-signature');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[WEBHOOK-NO-SECRETS]'), 'RazorpayPlugin');
    });

    it('accepts a valid signature and routes as before (ignored event types still return quietly)', async () => {
        const { service } = buildService(configuredMethods);
        const { body, rawBody } = webhookBody('payment.downtime.started');
        const actual = await service.processWebhook(signLikeRazorpay(rawBody, ACCOUNT_ONE_SECRET), body, rawBody);
        expect(actual).toBe('processed');
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('a genuine payment.failed records history but does NOT revert (the customer may retry on the same checkout)', async () => {
        const order = { id: 42, code: 'ORDER42', state: 'ArrangingPayment', channels: [], payments: [] };
        const connection: any = {
            getRepository: (_ctx: unknown, entity: any) =>
                entity === PaymentMethod ? { find: async () => configuredMethods } : { findOne: async () => order },
        };
        const orderService: any = { transitionToState: vi.fn(), updateCustomFields: vi.fn(), getNextOrderStates: vi.fn() };
        const historyService: any = { createHistoryEntryForOrder: vi.fn(async () => undefined) };
        const settlementService: any = {
            resolveChannelContext: async () => ({}),
            getRazorpayClientForCtx: async () => ({}),
            settleFromRazorpay: vi.fn(async () => ({ status: 'no-capture', orderCode: 'ORDER42' })),
        };
        const service = new RazorpayWebhookService(
            connection, orderService, { create: async () => ({}) } as any, historyService, {} as any, settlementService,
        );
        const { body, rawBody } = webhookBody('payment.failed');
        const actual = await service.processWebhook(signLikeRazorpay(rawBody, ACCOUNT_ONE_SECRET), body, rawBody);
        expect(actual).toBe('processed');
        expect(settlementService.settleFromRazorpay).toHaveBeenCalledOnce();
        expect(orderService.transitionToState).not.toHaveBeenCalled();
        expect(orderService.updateCustomFields).not.toHaveBeenCalled();
        expect(historyService.createHistoryEntryForOrder).toHaveBeenCalledWith(
            expect.objectContaining({ orderId: 42, data: expect.objectContaining({ status: 'Failed' }) }),
            false,
        );
    });

    it("accepts the second account's secret, even when that method is disabled", async () => {
        const { service, touchedEntities } = buildService(configuredMethods);
        const { body, rawBody } = webhookBody('payment.captured');
        // Valid signature → routing runs; the stub order lookup finds nothing, which
        // proves the door let it through to the settlement path.
        await expect(service.processWebhook(signLikeRazorpay(rawBody, ACCOUNT_TWO_SECRET), body, rawBody))
            .rejects.toThrow('Order order_1 not found');
        expect(touchedEntities).toContain('Order');
    });
});
