import { describe, expect, it, vi } from 'vitest';
import { AbandonedCartService } from './abandoned-cart.service';
import { AbandonedCartConfig } from '../types';

function makeConfig(): AbandonedCartConfig {
    return {
        enabled: true,
        minOrderValueMinor: 30000,
        costPerMessageMinor: 0,
        stages: [
            { delayValue: 12, delayUnit: 'hours', templateName: 't1', language: 'en', bodyVars: [{ kind: 'token', value: '{firstName}' }] },
            { delayValue: 3, delayUnit: 'days', templateName: 't2', language: 'en', bodyVars: [] },
            { delayValue: 7, delayUnit: 'days', templateName: 't3', language: 'en', bodyVars: [] },
        ],
    };
}

// Mirrors the worked example: stage 1 = 30m after abandonment, stage 2 = 1h after stage 1,
// stage 3 = 2h after stage 2.
function makeGapConfig(): AbandonedCartConfig {
    return {
        enabled: true,
        minOrderValueMinor: 30000,
        costPerMessageMinor: 0,
        stages: [
            { delayValue: 30, delayUnit: 'seconds', templateName: 't1', language: 'en', bodyVars: [] },
            { delayValue: 60, delayUnit: 'seconds', templateName: 't2', language: 'en', bodyVars: [] },
            { delayValue: 120, delayUnit: 'seconds', templateName: 't3', language: 'en', bodyVars: [] },
        ],
    };
}

function secondsAgo(seconds: number): Date {
    return new Date(Date.now() - seconds * 1000);
}

describe('AbandonedCartService.processOrder (gap-based timing)', () => {
    const service = new AbandonedCartService({} as any, {} as any, {} as any, {} as any, {} as any);

    it('sends stage 1 once its delay has elapsed since the cart was created', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(80 * 3600), customer: { firstName: 'Asha', phoneNumber: '91999' } };
        const decision = service.processOrder(order, makeConfig(), undefined, new Date());
        expect(decision?.stageToSend).toBe(1);
        expect(decision?.row.stagesSent).toBe(1);
    });

    it('returns null before stage 1 delay elapses', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(2 * 3600), customer: { firstName: 'Asha', phoneNumber: '91999' } };
        expect(service.processOrder(order, makeConfig(), undefined, new Date())).toBeNull();
    });

    it('advances to stage 2 only after stage 2 GAP elapses since the previous send (lastSentAt)', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(200 * 3600), customer: { firstName: 'Asha', phoneNumber: '91999' } };
        const existing: any = { orderId: '1', channelId: 'c1', stagesSent: 1, lastSentAt: secondsAgo(80 * 3600) }; // 80h since stage 1 > 72h gap
        const decision = service.processOrder(order, makeConfig(), existing, new Date());
        expect(decision?.stageToSend).toBe(2);
        expect(decision?.row.stagesSent).toBe(2);
    });

    it('does NOT advance to stage 2 just because the cart is old — the gap is measured from the last send', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(200 * 3600), customer: { firstName: 'Asha', phoneNumber: '91999' } };
        const existing: any = { orderId: '1', channelId: 'c1', stagesSent: 1, lastSentAt: secondsAgo(1 * 3600) }; // only 1h since stage 1 < 72h gap
        expect(service.processOrder(order, makeConfig(), existing, new Date())).toBeNull();
    });

    it('skips when all stages already sent (no dupes)', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(500 * 3600), customer: { firstName: 'Asha', phoneNumber: '91999' } };
        const existing: any = { orderId: '1', channelId: 'c1', stagesSent: 3, lastSentAt: secondsAgo(500 * 3600) };
        expect(service.processOrder(order, makeConfig(), existing, new Date())).toBeNull();
    });

    it('skips ineligible carts (below min value)', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 10000, createdAt: secondsAgo(80 * 3600), customer: { firstName: 'Asha', phoneNumber: '91999' } };
        expect(service.processOrder(order, makeConfig(), undefined, new Date())).toBeNull();
    });

    it('skips carts with no customer phone', () => {
        const order: any = { id: 1, code: 'A', state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(80 * 3600), customer: { firstName: 'Asha', phoneNumber: null } };
        expect(service.processOrder(order, makeConfig(), undefined, new Date())).toBeNull();
    });

    describe('test sends are excluded from analytics', () => {
        it('sendTestToPhone sends the message but writes NO analytics event', async () => {
            const eventSave = vi.fn();
            const getRepository = vi.fn(() => ({ save: eventSave, find: vi.fn(), findOne: vi.fn() }));
            const connection: any = { getRepository };
            const settingsStore: any = { get: vi.fn().mockResolvedValue(makeConfig()) };
            const msg91: any = { sendAbandonedCartWhatsapp: vi.fn().mockResolvedValue(true) };
            const svc = new AbandonedCartService(connection, settingsStore, {} as any, {} as any, msg91);
            const result = await svc.sendTestToPhone({ channelId: 1 } as any, '919999999999', 1);
            expect(result).toBe(true);
            expect(msg91.sendAbandonedCartWhatsapp).toHaveBeenCalledTimes(1);
            expect(eventSave).not.toHaveBeenCalled();
        });
    });

    describe('worked example: 30s / 60s / 120s gaps', () => {
        it('sends stage 1 once 30s passed since createdAt', () => {
            const order: any = { id: 9, state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(31), customer: { phoneNumber: '91999' } };
            expect(service.processOrder(order, makeGapConfig(), undefined, new Date())?.stageToSend).toBe(1);
        });
        it('sends stage 2 once 60s passed since stage 1 send', () => {
            const order: any = { id: 9, state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(1000), customer: { phoneNumber: '91999' } };
            const existing: any = { orderId: '9', channelId: 'c1', stagesSent: 1, lastSentAt: secondsAgo(61) };
            expect(service.processOrder(order, makeGapConfig(), existing, new Date())?.stageToSend).toBe(2);
        });
        it('does not send stage 2 only 30s after stage 1 send', () => {
            const order: any = { id: 9, state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(1000), customer: { phoneNumber: '91999' } };
            const existing: any = { orderId: '9', channelId: 'c1', stagesSent: 1, lastSentAt: secondsAgo(30) };
            expect(service.processOrder(order, makeGapConfig(), existing, new Date())).toBeNull();
        });
        it('sends stage 3 once 120s passed since stage 2 send', () => {
            const order: any = { id: 9, state: 'AddingItems', totalWithTax: 40000, createdAt: secondsAgo(2000), customer: { phoneNumber: '91999' } };
            const existing: any = { orderId: '9', channelId: 'c1', stagesSent: 2, lastSentAt: secondsAgo(121) };
            expect(service.processOrder(order, makeGapConfig(), existing, new Date())?.stageToSend).toBe(3);
        });
    });
});
