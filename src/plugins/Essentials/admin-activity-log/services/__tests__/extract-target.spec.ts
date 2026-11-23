import { describe, expect, it } from 'vitest';
import { extractTarget } from '../extract-target';

describe('extractTarget', () => {
    describe('entityType derivation', () => {
        it.each([
            ['updateProduct', 'Product'],
            ['createToken', 'Token'],
            ['cancelOrder', 'Order'],
            ['refundOrder', 'Order'],
            ['setSettingsStoreValue', 'SettingsStoreValue'],
        ])('derives %s -> %s', (inputOperation, expectedEntityType) => {
            expect(extractTarget(inputOperation, {}).entityType).toBe(expectedEntityType);
        });

        it.each([
            ['deleteProducts', 'Product'],
            ['updateProductVariants', 'ProductVariant'],
        ])('singularises %s -> %s', (inputOperation, expectedEntityType) => {
            expect(extractTarget(inputOperation, {}).entityType).toBe(expectedEntityType);
        });

        // Regression: `settlePayment` matched the shorter verb `set` and produced
        // the entity type `tlePayment`, which shipped and showed up in the UI.
        it('requires the verb to end on a camelCase boundary', () => {
            expect(extractTarget('settlePayment', {}).entityType).toBe('Payment');
        });

        // Regression: compound names kept the whole tail, so the same entity got
        // a different entityType per mutation and the per-entity lookup broke.
        it.each([
            ['addFulfillmentToOrder', 'Fulfillment'],
            ['transitionFulfillmentToState', 'Fulfillment'],
            ['transitionOrderToState', 'Order'],
            ['removeProductsFromChannel', 'Product'],
            ['addOptionGroupToProduct', 'OptionGroup'],
            ['setCustomerForOrder', 'Customer'],
        ])('cuts %s at the connector -> %s', (inputOperation, expectedEntityType) => {
            expect(extractTarget(inputOperation, {}).entityType).toBe(expectedEntityType);
        });

        it('returns null when no verb matches, rather than guessing', () => {
            expect(extractTarget('orders', {}).entityType).toBeNull();
        });
    });

    describe('target ids and blast radius', () => {
        it('reads a direct id argument', () => {
            const actual = extractTarget('deleteProduct', { id: 412 });
            expect(actual.entityId).toBe('412');
            expect(actual.targetCount).toBe(1);
        });

        it('reads an id nested in an input object', () => {
            const actual = extractTarget('updateProduct', { input: { id: 110, enabled: false } });
            expect(actual.entityId).toBe('110');
        });

        it('records blast radius and no single id for a bulk call', () => {
            const actual = extractTarget('updateProductVariants', {
                input: [{ id: 1 }, { id: 2 }, { id: 3 }],
            });
            expect(actual.entityId).toBeNull();
            expect(actual.targetCount).toBe(3);
        });

        it('falls back to a suffixed id argument', () => {
            expect(extractTarget('addFulfillmentToOrder', { orderId: 77 }).entityId).toBe('77');
        });

        it('never throws on an unrecognised argument shape', () => {
            const actual = extractTarget('updateProduct', { options: { filter: {} } });
            expect(actual.entityId).toBeNull();
            expect(actual.targetCount).toBe(1);
        });
    });
});

describe('extractTarget operation overrides', () => {
    /**
     * These two mutations name the thing being attached, not the thing being
     * edited. Left to the verb grammar they parse to `VariantTag` and
     * `ProductTag` — entities that do not exist — and because
     * (entityType, entityId) is the indexed lookup behind an entity's own
     * history, the tagging then never appears on the variant or product it
     * happened to.
     */
    it('files a variant tagging under the variant it tagged', () => {
        const actual = extractTarget('setVariantTags', { variantId: 949, tagIds: [2] });

        expect(actual).toEqual({ entityType: 'ProductVariant', entityId: '949', targetCount: 1 });
    });

    it('files a product tagging under the product it tagged', () => {
        const actual = extractTarget('setProductTags', { productId: 413, tagIds: [3] });

        expect(actual).toEqual({ entityType: 'Product', entityId: '413', targetCount: 1 });
    });

    it('keeps the corrected entity type even when the id argument is missing', () => {
        const actual = extractTarget('setVariantTags', { tagIds: [2] });

        expect(actual).toEqual({ entityType: 'ProductVariant', entityId: null, targetCount: 1 });
    });
});
