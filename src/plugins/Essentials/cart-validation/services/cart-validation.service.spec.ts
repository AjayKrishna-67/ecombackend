import { OrderLine, ProductVariant } from '@vendure/core';
import { describe, expect, it } from 'vitest';
import { CartValidationService } from './cart-validation.service';
import { ProductStockLevel } from '../../../Stock/product-stock/entities/product-stock-level.entity';

const mockCtx: any = { languageCode: 'en', channelId: 1 };

/** Chainable query-builder stub: every method but the terminal ones returns itself. */
function queryBuilderStub(result: { many?: any[]; one?: any }) {
    const qb: any = {
        leftJoinAndSelect: () => qb,
        where: () => qb,
        andWhere: () => qb,
        select: () => qb,
        addSelect: () => qb,
        getMany: async () => result.many ?? [],
        getOne: async () => result.one ?? null,
        getRawMany: async () => [],
        getRawOne: async () => null,
    };
    return qb;
}

/**
 * `entityRepos` maps an entity class to what its repo should return.
 * Any entity not listed throws -- that's how a test asserts "this should
 * not be queried at all" (e.g. OrderLine when `order.lines` was already
 * supplied by the caller).
 */
function mockConnection(entityRepos: Map<Function, { variants?: any[]; variant?: any; lines?: any[] }>) {
    return {
        getRepository: (ctx: any, entity: Function) => {
            const config = entityRepos.get(entity);
            if (!config) {
                throw new Error(`Unexpected query against ${entity.name} -- should not have been reached`);
            }
            if (entity === OrderLine) {
                return { find: async () => config.lines ?? [] };
            }
            return { createQueryBuilder: () => queryBuilderStub({ many: config.variants, one: config.variant }) };
        },
    } as any;
}

describe('CartValidationService.validateOrder', () => {
    it('treats a line whose variant was deleted as unavailable instead of throwing, when order.lines is already loaded', async () => {
        // Arrange: reproduces the prod state found in `order_line` rows whose
        // productVariantId points at a soft-deleted ProductVariant. The bulk
        // variant lookup simply finds nothing for that id -- `productVariantId`
        // itself is a plain column, always present, so this never touches the
        // (possibly unloaded) `productVariant` relation.
        const connection = mockConnection(new Map([[ProductVariant, { variants: [] }]]));
        const service = new CartValidationService(connection);
        const orphanLine: any = { id: 999, quantity: 1, productVariantId: 9999 };
        const inputOrder: any = { id: 1, code: 'TEST-ORPHAN', active: true, lines: [orphanLine] };

        // Act
        const actualResult = await service.validateOrder(mockCtx, inputOrder);

        // Assert
        expect(actualResult.isValid).toBe(false);
        expect(actualResult.hasUnavailableItems).toBe(true);
        expect(actualResult.unavailableItems).toEqual([
            {
                orderLineId: 999,
                productName: 'Unknown',
                variantName: 'Unknown',
                reason: 'This product has been removed and is no longer available',
            },
        ]);
    });

    it('fetches lines itself and still works when order.lines was never loaded (client did not select `lines`)', async () => {
        // Arrange: Vendure's `@Relations` decorator on activeOrder/addItemToOrder
        // only joins relations the client's own GraphQL selection asked for.
        // A client selecting `validationStatus` without also selecting `lines`
        // leaves `order.lines` `undefined` entirely -- this is the exact crash
        // reproduced live: "Cannot read properties of undefined (reading 'length')".
        const orphanLine: any = { id: 1001, quantity: 1, productVariantId: 9999 };
        const connection = mockConnection(new Map<Function, any>([
            [OrderLine, { lines: [orphanLine] }],
            [ProductVariant, { variants: [] }],
        ]));
        const service = new CartValidationService(connection);
        const inputOrder: any = { id: 2, code: 'TEST-NO-LINES-SELECTED', active: true, lines: undefined };

        // Act
        const actualResult = await service.validateOrder(mockCtx, inputOrder);

        // Assert
        expect(actualResult.isValid).toBe(false);
        expect(actualResult.unavailableItems).toEqual([
            {
                orderLineId: 1001,
                productName: 'Unknown',
                variantName: 'Unknown',
                reason: 'This product has been removed and is no longer available',
            },
        ]);
    });

    it('returns a valid empty result for an order with no lines at all, without querying anything', async () => {
        // Arrange: an empty array is not nullish, so the `order.lines ?? fetch()`
        // fallback must NOT trigger here -- asserted by giving no repos at all.
        const connection = mockConnection(new Map());
        const service = new CartValidationService(connection);
        const inputOrder: any = { id: 3, code: 'TEST-EMPTY', active: true, lines: [] };

        // Act
        const actualResult = await service.validateOrder(mockCtx, inputOrder);

        // Assert
        expect(actualResult).toEqual({
            isValid: true,
            hasUnavailableItems: false,
            totalUnavailableItems: 0,
            unavailableItems: [],
            // The channel sets no minimum order value, so the order meets it.
            meetsMinimumOrder: true,
            minimumOrderAmount: null,
            amountToMinimumOrder: 0,
            minimumOrderMessage: null,
        });
    });

    it('marks a line available when its variant is found, enabled, and its product is enabled', async () => {
        // Arrange
        const mockVariant: any = {
            id: 42,
            productId: 100,
            enabled: true,
            product: { enabled: true, name: 'Lemon' },
            name: 'Lemon (Large 10 Nos)',
        };
        const connection = mockConnection(new Map<Function, any>([
            [ProductVariant, { variants: [mockVariant] }],
            // Not a pooled product -- `getRawMany` stub returns [] regardless,
            // this entry only needs to exist so the repo lookup doesn't throw.
            [ProductStockLevel, {}],
        ]));
        const service = new CartValidationService(connection);
        const line: any = { id: 2001, quantity: 1, productVariantId: 42 };
        const inputOrder: any = { id: 4, code: 'TEST-HAPPY-PATH', active: true, lines: [line] };

        // Act
        const actualResult = await service.validateOrder(mockCtx, inputOrder);

        // Assert
        expect(actualResult).toEqual({
            isValid: true,
            hasUnavailableItems: false,
            totalUnavailableItems: 0,
            unavailableItems: [],
            message: null,
            // The channel sets no minimum order value, so the order meets it.
            meetsMinimumOrder: true,
            minimumOrderAmount: null,
            amountToMinimumOrder: 0,
            minimumOrderMessage: null,
        });
    });
});
