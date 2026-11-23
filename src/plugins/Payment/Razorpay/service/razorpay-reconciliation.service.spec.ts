import { Channel, Logger, Order } from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RazorpayReconciliationService } from './razorpay-reconciliation.service';

const NOW_MS = Date.parse('2026-10-21T12:00:00Z');
const MINUTE_MS = 60 * 1000;

function buildOrder(overrides: Record<string, unknown> = {}): any {
    return {
        id: 42,
        code: 'ORDER42',
        state: 'ArrangingPayment',
        totalWithTax: 25000,
        updatedAt: new Date(NOW_MS - 30 * MINUTE_MS),
        customFields: { razorpayOrderId: 'order_A', isPaymentWindowOpen: true },
        payments: [],
        ...overrides,
    };
}

interface Scenario {
    order: any;
    settleStatus?: string;
    activity?: string;
    razorpayOrderAgeMs?: number;
    revertResult?: unknown;
}

/**
 * Runs one real reconciliation pass over a single city channel holding one
 * ArrangingPayment order, with Razorpay and the settlement service stubbed.
 */
async function runReconciliation(scenario: Scenario) {
    const orderService: any = {
        transitionToState: vi.fn(async () => scenario.revertResult ?? { id: scenario.order.id, state: 'AddingItems' }),
        updateCustomFields: vi.fn(async () => undefined),
    };
    const settlementService: any = {
        getRazorpayClientForCtx: vi.fn(async () => ({})),
        settleFromRazorpay: vi.fn(async () => ({ status: scenario.settleStatus ?? 'no-capture', orderCode: scenario.order.code })),
        getRazorpayOrderCreatedAtMs: vi.fn(async () => NOW_MS - (scenario.razorpayOrderAgeMs ?? 20 * MINUTE_MS)),
        getPaymentActivity: vi.fn(async () => scenario.activity ?? 'unpaid'),
        emitMoneyStuckAlert: vi.fn(async () => undefined),
    };
    const connection: any = {
        getRepository: (ctxOrEntity: unknown, maybeEntity?: unknown) => {
            const entity = maybeEntity ?? ctxOrEntity;
            if (entity === Channel) {
                return { find: async () => [{ id: 2, code: 'madurai', token: 'madurai-token' }] };
            }
            if (entity === Order) {
                return {
                    find: async (options: any) =>
                        options.where.state === 'ArrangingPayment' && !options.skip ? [scenario.order] : [],
                };
            }
            throw new Error(`Unexpected repository ${String(entity)}`);
        },
    };
    const requestContextService: any = { create: async () => ({ channelId: 2, channel: { code: 'madurai' } }) };
    const cacheService: any = { get: async () => undefined, set: async () => undefined };
    const service = new RazorpayReconciliationService(connection, orderService, requestContextService, cacheService, settlementService);
    await service.reconcilePendingOrders();
    return { orderService, settlementService };
}

describe('RazorpayReconciliationService stale ArrangingPayment orders', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        for (const level of ['info', 'warn', 'error'] as const) {
            vi.spyOn(Logger, level).mockImplementation(() => undefined);
        }
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('reverts a timed-out checkout that Razorpay confirms unpaid', async () => {
        const { orderService } = await runReconciliation({ order: buildOrder(), activity: 'unpaid' });
        expect(orderService.transitionToState).toHaveBeenCalledWith(expect.anything(), 42, 'AddingItems');
        expect(orderService.updateCustomFields).toHaveBeenCalledWith(expect.anything(), 42, { isPaymentWindowOpen: false });
    });

    it('does not revert while an attempt still awaits UPI/bank approval', async () => {
        const { orderService, settlementService } = await runReconciliation({ order: buildOrder(), activity: 'in-progress' });
        expect(orderService.transitionToState).not.toHaveBeenCalled();
        expect(settlementService.emitMoneyStuckAlert).not.toHaveBeenCalled();
    });

    it.each(['paid', 'unknown'])("refuses to revert and alerts when Razorpay says '%s'", async activity => {
        const { orderService, settlementService } = await runReconciliation({ order: buildOrder(), activity });
        expect(orderService.transitionToState).not.toHaveBeenCalled();
        expect(settlementService.emitMoneyStuckAlert).toHaveBeenCalledOnce();
    });

    it('leaves a checkout younger than 5 minutes alone without asking Razorpay', async () => {
        const { orderService, settlementService } = await runReconciliation({ order: buildOrder(), razorpayOrderAgeMs: 2 * MINUTE_MS });
        expect(orderService.transitionToState).not.toHaveBeenCalled();
        expect(settlementService.getPaymentActivity).not.toHaveBeenCalled();
    });

    it('never fakes a placement for an underpaid recorded payment: no transition, settle path + alert instead', async () => {
        const underpaid = buildOrder({ payments: [{ state: 'Settled', amount: 24000, transactionId: 'pay_A' }] });
        const { orderService, settlementService } = await runReconciliation({ order: underpaid, settleStatus: 'incomplete', activity: 'paid' });
        expect(settlementService.settleFromRazorpay).toHaveBeenCalledOnce();
        expect(orderService.transitionToState).not.toHaveBeenCalled();
        expect(settlementService.emitMoneyStuckAlert).toHaveBeenCalledOnce();
    });

    it('never reverts an order that already holds a recorded payment, even without a Razorpay order id', async () => {
        const manual = buildOrder({
            customFields: {},
            payments: [{ state: 'Settled', amount: 25000, transactionId: 'cash-1' }],
        });
        const { orderService } = await runReconciliation({ order: manual });
        expect(orderService.transitionToState).not.toHaveBeenCalled();
    });

    it('does not report success when the revert transition is refused', async () => {
        const { orderService } = await runReconciliation({
            order: buildOrder(),
            activity: 'unpaid',
            revertResult: { errorCode: 'ORDER_STATE_TRANSITION_ERROR', message: 'refused' },
        });
        expect(orderService.transitionToState).toHaveBeenCalledOnce();
        expect(orderService.updateCustomFields).not.toHaveBeenCalled();
    });
});
