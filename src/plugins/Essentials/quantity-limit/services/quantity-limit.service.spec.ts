import { OrderLine, ProductVariant } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { QuantityLimitService } from './quantity-limit.service';
import { StockAvailabilityOrderResolver } from '../api/quantity-limit.resolver';

const mockCtx: any = { languageCode: 'en', channelId: 1 };

/**
 * Connection stub that records every query. ProductVariant queries return
 * `variants`; OrderLine (order-history SUM) queries return `alreadyOrdered`.
 */
function mockConnection(variants: any[], alreadyOrdered = 0) {
    const queries: string[] = [];
    const connection: any = {
        getRepository: (_ctx: any, entity: Function) => ({
            createQueryBuilder: () => {
                queries.push(entity.name);
                const qb: any = {
                    leftJoinAndSelect: () => qb,
                    innerJoin: () => qb,
                    where: () => qb,
                    andWhere: () => qb,
                    select: () => qb,
                    getMany: async () => variants,
                    getOne: async () => variants[0] ?? null,
                    getRawOne: async () => ({ totalQuantity: String(alreadyOrdered) }),
                };
                return qb;
            },
        }),
    };
    return { connection, queries };
}

function variant(id: number, maxOrderQuantity: number | null) {
    return {
        id,
        customFields: { maxOrderQuantity },
        product: { translations: [{ languageCode: 'en', name: `Product ${id}` }] },
        translations: [],
    };
}

describe('QuantityLimitService.validateOrder', () => {
    it('loads every line\'s limit in ONE variant query, and queries history only for limited variants', async () => {
        // Arrange: 3 lines, only variant 2 has a limit -- previously 3 variant queries.
        const { connection, queries } = mockConnection([variant(1, null), variant(2, 3), variant(3, null)], 1);
        const service = new QuantityLimitService(connection);
        const order: any = {
            code: 'QL-1',
            customer: { id: 7 },
            lines: [1, 2, 3].map(id => ({ id: 100 + id, quantity: 2, productVariant: { id } })),
        };

        // Act
        const actualResult = await service.validateOrder(mockCtx, order);

        // Assert
        expect(queries).toEqual([ProductVariant.name, OrderLine.name]);
        expect(actualResult.isValid).toBe(true);
    });

    it('reports the same violation as before when cart + history exceed the limit', async () => {
        // Arrange: max 3, already bought 2, cart has 2 -> 1 more allowed.
        const { connection } = mockConnection([variant(2, 3)], 2);
        const service = new QuantityLimitService(connection);
        const order: any = { code: 'QL-2', customer: { id: 7 }, lines: [{ id: 102, quantity: 2, productVariant: { id: 2 } }] };

        // Act
        const actualResult = await service.validateOrder(mockCtx, order);

        // Assert
        expect(actualResult.isValid).toBe(false);
        expect(actualResult.violations).toEqual([
            {
                orderLineId: 102,
                productName: 'Product 2',
                variantName: 'Product 2',
                currentQuantity: 2,
                maxQuantity: 3,
                maxAllowedInCart: 1,
                reason: 'Maximum quantity for Product 2 is 3. You have already purchased 2 in previous orders. Your cart can only have 1 of this item.',
                limitStartDate: null,
            },
        ]);
    });

    it('validateCustomerQuantity (used by the add-to-cart interceptor) still treats an unknown variant as unlimited', async () => {
        // Arrange
        const { connection } = mockConnection([]);
        const service = new QuantityLimitService(connection);

        // Act
        const actualResult = await service.validateCustomerQuantity(mockCtx, 7, 999, 50);

        // Assert
        expect(actualResult).toEqual({
            isValid: true,
            maxQuantity: null,
            alreadyOrdered: 0,
            remaining: Infinity,
            requiresLogin: false,
            productName: 'Unknown',
            startDate: null,
        });
    });
});

describe('StockAvailabilityOrderResolver', () => {
    it('runs the stock check once per order when both isAvailable and unavailableReason are selected', async () => {
        // Arrange
        let calls = 0;
        const service: any = {
            checkStockAvailability: async () => {
                calls++;
                return { isAvailable: false, unavailableReason: 'Lemon is currently out of stock' };
            },
        };
        const resolver = new StockAvailabilityOrderResolver(service);
        const order: any = { code: 'QL-3', active: true, lines: [] };

        // Act: sibling fields resolve concurrently.
        const [actualAvailable, actualReason] = await Promise.all([
            resolver.isAvailable(mockCtx, order),
            resolver.unavailableReason(mockCtx, order),
        ]);

        // Assert
        expect(calls).toBe(1);
        expect(actualAvailable).toBe(false);
        expect(actualReason).toBe('Lemon is currently out of stock');
    });

    it('does not share a result between two different orders', async () => {
        // Arrange
        let calls = 0;
        const service: any = { checkStockAvailability: async () => ({ isAvailable: ++calls === 1, unavailableReason: null }) };
        const resolver = new StockAvailabilityOrderResolver(service);

        // Act
        const actualFirst = await resolver.isAvailable(mockCtx, { active: true, lines: [] } as any);
        const actualSecond = await resolver.isAvailable(mockCtx, { active: true, lines: [] } as any);

        // Assert
        expect(calls).toBe(2);
        expect([actualFirst, actualSecond]).toEqual([true, false]);
    });
});
