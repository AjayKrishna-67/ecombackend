import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CouponCodeResolver } from './promotion-codes.plugin';

// Shape returned by PromotionService.validateCouponCode when a limit is hit.
// isGraphQlErrorResult() keys on errorCode + message + __typename.
const limitError = (couponCode: string) => ({
    __typename: 'CouponCodeLimitError',
    errorCode: 'COUPON_CODE_LIMIT_ERROR',
    message: 'COUPON_CODE_LIMIT_ERROR',
    couponCode,
    limit: 1,
});

const promo = (id: string, couponCode: string | null = null, actions: any[] = []) => ({
    id,
    couponCode,
    conditions: [],
    actions,
});

describe('CouponCodeResolver.getCouponCodeList', () => {
    let promotionService: {
        findAll: ReturnType<typeof vi.fn>;
        validateCouponCode: ReturnType<typeof vi.fn>;
        getExhaustedPromotionIds: ReturnType<typeof vi.fn>;
    };
    let customerService: { findOneByUserId: ReturnType<typeof vi.fn> };
    let resolver: CouponCodeResolver;

    const connection = {
        getRepository: () => ({
            findOne: async () => null,
            find: async () => [],
        }),
    };
    const productVariantService = {
        findByIds: vi.fn(async (_ctx: any, ids: string[]) => ids.map(id => ({ id }))),
    };
    const loggedInCtx = { activeUserId: 'user-1' } as any;

    beforeEach(() => {
        productVariantService.findByIds.mockClear();
        promotionService = {
            findAll: vi.fn(async () => ({ items: [], totalItems: 0 })),
            validateCouponCode: vi.fn(async (_ctx: any, code: string) => promo('x', code)),
            getExhaustedPromotionIds: vi.fn(async () => new Set<string>()),
        };
        customerService = { findOneByUserId: vi.fn(async () => ({ id: 'cust-1' })) };
        resolver = new CouponCodeResolver(
            promotionService as any,
            connection as any,
            productVariantService as any,
            customerService as any,
        );
    });

    it('hides a coupon the customer has already used up', async () => {
        promotionService.findAll.mockResolvedValue({
            items: [promo('1', 'USED1'), promo('2', 'FRESH')],
            totalItems: 2,
        });
        promotionService.validateCouponCode.mockImplementation(async (_ctx: any, code: string) =>
            code === 'USED1' ? limitError(code) : promo('2', code),
        );

        const result = await resolver.getCouponCodeList(loggedInCtx);

        expect(result.items.map((i: any) => i.promotion.couponCode)).toEqual(['FRESH']);
        expect(result.totalItems).toBe(1);
        expect(promotionService.validateCouponCode).toHaveBeenCalledWith(loggedInCtx, 'USED1', 'cust-1');
    });

    it('shows every coupon to a guest (no customer to check against)', async () => {
        promotionService.findAll.mockResolvedValue({
            items: [promo('1', 'USED1'), promo('2', 'FRESH')],
            totalItems: 2,
        });

        const result = await resolver.getCouponCodeList({} as any);

        expect(result.items).toHaveLength(2);
        expect(result.totalItems).toBe(2);
        expect(customerService.findOneByUserId).not.toHaveBeenCalled();
        expect(promotionService.validateCouponCode).not.toHaveBeenCalled();
    });

    it('hides an exhausted automatic (no-code) promotion via getExhaustedPromotionIds', async () => {
        promotionService.findAll.mockResolvedValue({
            items: [promo('1'), promo('2')],
            totalItems: 2,
        });
        promotionService.getExhaustedPromotionIds.mockResolvedValue(new Set(['1']));

        const result = await resolver.getCouponCodeList(loggedInCtx);

        expect(result.items.map((i: any) => i.promotion.id)).toEqual(['2']);
        expect(result.totalItems).toBe(1);
        expect(promotionService.validateCouponCode).not.toHaveBeenCalled();
    });

    it('returns the products a free_product action gives away', async () => {
        const inputPromotion = promo('1', 'ONION649', [
            { code: 'free_product', args: [{ name: 'productVariantIds', value: '["1278"]' }] },
        ]);
        promotionService.findAll.mockResolvedValue({ items: [inputPromotion], totalItems: 1 });

        const result = await resolver.getCouponCodeList({} as any);

        expect(productVariantService.findByIds).toHaveBeenCalledWith(expect.anything(), ['1278']);
        expect(result.items[0].productVariants).toEqual([{ id: '1278' }]);
    });
});
