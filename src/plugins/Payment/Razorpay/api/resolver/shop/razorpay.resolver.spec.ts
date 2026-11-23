import { ForbiddenError } from '@vendure/core';
import { describe, expect, it, vi } from 'vitest';
import { RazorpayResolver } from './razorpay.resolver';

const OWNER_USER_ID = 7;
const ORDER_ID = 42;

function buildOrder(state = 'AddingItems'): any {
    return { id: ORDER_ID, code: 'ORDER42', state, customFields: {}, customer: { user: { id: OWNER_USER_ID } } };
}

/** Resolver with an order to find, and spies proving whether the guard let the call through. */
function buildResolver(order = buildOrder(), settlementService: any = {}) {
    const orderService: any = {
        findOne: vi.fn(async () => order),
        transitionToState: vi.fn(async () => ({})),
        updateCustomFields: vi.fn(async () => undefined),
    };
    const queryBuilder: any = {
        leftJoin: () => queryBuilder,
        where: () => queryBuilder,
        andWhere: () => queryBuilder,
        getOne: async () => null,
    };
    const connection: any = { getRepository: () => ({ createQueryBuilder: () => queryBuilder }) };
    return { resolver: new RazorpayResolver(orderService, connection, settlementService), orderService };
}

/** GraphQL passes ids as strings while entity ids are numbers; the guard must compare them as ids. */
const anonymousCtx: any = { channelId: 1 };
const ownerCtx: any = { channelId: 1, activeUserId: String(OWNER_USER_ID) };
const otherCustomerCtx: any = { channelId: 1, activeUserId: '99' };
const guestSessionCtx: any = { channelId: 1, session: { activeOrderId: String(ORDER_ID) } };
const otherGuestCtx: any = { channelId: 1, session: { activeOrderId: '43' } };

describe('RazorpayResolver ownership guard', () => {
    it.each([
        ['an anonymous caller', anonymousCtx],
        ['another logged-in customer', otherCustomerCtx],
        ['a guest whose session holds a different order', otherGuestCtx],
    ])('generateRazorpayOrderId refuses %s before touching the order', async (_label, ctx) => {
        const { resolver, orderService } = buildResolver();
        const actual = await resolver.generateRazorpayOrderId(ctx, String(ORDER_ID));
        expect(actual).toEqual({ success: false, errorMessage: 'Unauthorized access' });
        expect(orderService.transitionToState).not.toHaveBeenCalled();
    });

    it('cancelRazorpayPayment refuses an anonymous caller', async () => {
        const { resolver, orderService } = buildResolver(buildOrder('ArrangingPayment'));
        const actual = await resolver.cancelRazorpayPayment(anonymousCtx, String(ORDER_ID));
        expect(actual).toEqual({ success: false, errorMessage: 'Unauthorized access' });
        expect(orderService.transitionToState).not.toHaveBeenCalled();
    });

    it.each([
        ['the logged-in owner', ownerCtx],
        ['the guest whose session holds this order', guestSessionCtx],
    ])('cancelRazorpayPayment lets %s through', async (_label, ctx) => {
        const { resolver } = buildResolver(buildOrder('AddingItems'));
        const actual = await resolver.cancelRazorpayPayment(ctx, String(ORDER_ID));
        expect(actual).toEqual({ success: true, reverted: false, state: 'AddingItems' });
    });

    describe('cancelRazorpayPayment when the app reports the Razorpay modal closed', () => {
        function settlementSaying(activity: string): any {
            return { getRazorpayClientForCtx: async () => ({}), getPaymentActivity: vi.fn(async () => activity) };
        }
        const arrangingOrder = () => ({ ...buildOrder('ArrangingPayment'), customFields: { razorpayOrderId: 'order_A' } });

        it('keeps the order while the customer is still approving in their UPI app', async () => {
            const { resolver, orderService } = buildResolver(arrangingOrder(), settlementSaying('in-progress'));
            const actual = await resolver.cancelRazorpayPayment(ownerCtx, String(ORDER_ID));
            expect(actual).toEqual({ success: false, errorMessage: 'Payment in progress' });
            expect(orderService.transitionToState).not.toHaveBeenCalled();
        });

        it('reverts to AddingItems when Razorpay confirms nothing was paid', async () => {
            const { resolver, orderService } = buildResolver(arrangingOrder(), settlementSaying('unpaid'));
            const actual = await resolver.cancelRazorpayPayment(ownerCtx, String(ORDER_ID));
            expect(actual).toEqual({ success: true, reverted: true, state: 'AddingItems' });
            expect(orderService.transitionToState).toHaveBeenCalledWith(ownerCtx, ORDER_ID, 'AddingItems');
        });
    });

    it('getRazorpayOrderStatus throws ForbiddenError for a stranger', async () => {
        const { resolver } = buildResolver();
        await expect(resolver.getRazorpayOrderStatus(anonymousCtx, String(ORDER_ID))).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('getRazorpayOrderStatus lets the owner through to the Razorpay lookup', async () => {
        const { resolver } = buildResolver({ ...buildOrder(), customFields: { razorpayOrderId: 'order_A' } });
        // Past the guard, the stub has no payment method configured: that error proves the guard passed.
        await expect(resolver.getRazorpayOrderStatus(ownerCtx, String(ORDER_ID))).rejects.toThrow(
            'Razorpay not configured for this channel',
        );
    });
});
