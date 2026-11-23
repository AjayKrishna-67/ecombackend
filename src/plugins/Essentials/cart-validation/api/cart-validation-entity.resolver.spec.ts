import { describe, expect, it, vi } from 'vitest';
import { CartValidationService } from '../services/cart-validation.service';
import { AvailabilityVariantDataLoader } from './availability-variant.dataloader';
import { CartValidationLineResolver } from './cart-validation-entity.resolver';

const mockCtx: any = { languageCode: 'en', channelId: 1 };

function stockLevel(stockOnHand: number, stockAllocated: number, channelId: number) {
    return { stockOnHand, stockAllocated, stockLocation: { channels: [{ id: channelId }] } };
}

const inStock: any = {
    id: 10, enabled: true, trackInventory: 'TRUE', product: { enabled: true },
    stockLevels: [stockLevel(5, 1, 1), stockLevel(100, 0, 2)],
};
const disabled: any = { id: 11, enabled: false, trackInventory: 'TRUE', product: { enabled: true }, stockLevels: [] };
const untracked: any = { id: 12, enabled: true, trackInventory: 'FALSE', product: { enabled: true }, stockLevels: [] };

/**
 * Builds the resolver the way Nest does for one request: a fresh loader per
 * request, sharing the singleton service. `findVariantsForAvailability` is the
 * only DB access, so spying on it counts the queries.
 */
function setup(variants: any[]) {
    const service = new CartValidationService({} as any);
    const find = vi
        .spyOn(service, 'findVariantsForAvailability')
        .mockImplementation(async (_ctx, ids) => variants.filter(v => ids.map(String).includes(String(v.id))));
    const resolver = new CartValidationLineResolver(service, new AvailabilityVariantDataLoader(service));
    return { resolver, find };
}

describe('CartValidationLineResolver', () => {
    it('loads every line of a cart in ONE query, however many lines and fields are selected', async () => {
        // Arrange: 4 lines (two share a variant), both fields selected per line --
        // previously 8 separate variant + stock-level joins.
        const { resolver, find } = setup([inStock, disabled, untracked]);
        const lines: any[] = [
            { id: 1, quantity: 2, productVariantId: 10 },
            { id: 2, quantity: 1, productVariantId: 11 },
            { id: 3, quantity: 1, productVariantId: 12 },
            { id: 4, quantity: 1, productVariantId: 10 },
        ];

        // Act: GraphQL starts every field resolver before awaiting any of them.
        await Promise.all(lines.flatMap(line => [
            resolver.isAvailable(mockCtx, line),
            resolver.unavailableReason(mockCtx, line),
        ]));

        // Assert
        expect(find).toHaveBeenCalledTimes(1);
        expect(find.mock.calls[0][1].map(String).sort()).toEqual(['10', '11', '12']);
    });

    it('keeps the per-line answers: stock is counted for the request channel only, against the line quantity', async () => {
        // Arrange: channel 1 has 5 on hand, 1 allocated -> 4 saleable. The 100 in
        // channel 2 must not count.
        const { resolver } = setup([inStock, disabled, untracked]);

        // Act + Assert
        expect(await resolver.isAvailable(mockCtx, { quantity: 4, productVariantId: 10 } as any)).toBe(true);
        expect(await resolver.unavailableReason(mockCtx, { quantity: 5, productVariantId: 10 } as any))
            .toBe('Only 4 available, kindly decrease quantity');
        expect(await resolver.unavailableReason(mockCtx, { quantity: 1, productVariantId: 11 } as any))
            .toBe('This variant is no longer available');
        expect(await resolver.isAvailable(mockCtx, { quantity: 999, productVariantId: 12 } as any)).toBe(true);
    });

    it('reports a line whose variant no longer exists as removed', async () => {
        // Arrange
        const { resolver } = setup([]);
        const line: any = { id: 9, quantity: 1, productVariantId: 9999 };

        // Act
        const [actualAvailable, actualReason] = await Promise.all([
            resolver.isAvailable(mockCtx, line),
            resolver.unavailableReason(mockCtx, line),
        ]);

        // Assert
        expect(actualAvailable).toBe(false);
        expect(actualReason).toBe('This product has been removed and is no longer available');
    });
});
