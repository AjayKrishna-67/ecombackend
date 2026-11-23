import { describe, expect, it } from 'vitest';
import { diffPayloads, toChangedPaths } from '../diff-payload';

/**
 * The fixtures below are the real stored payloads of log rows 29 and 30 —
 * two consecutive `updateProduct` calls on product #731 where the operator
 * edited only the English description. They are kept verbatim because the whole
 * point of this module is that a full-form resubmit looks like a change to
 * everything, and a hand-simplified fixture would not exercise that.
 */
const inputBefore = {
    input: {
        id: 731,
        enabled: true,
        featuredAssetId: 5693,
        assetIds: [5693],
        facetValueIds: [85],
        translations: [
            {
                id: 731,
                languageCode: 'en',
                name: 'Aavin butter unsalted ',
                slug: 'aavin-butter-unsalted-1',
                description: '',
                customFields: { localName: null },
            },
            { languageCode: 'ta', name: '', slug: '', description: '', customFields: {} },
            { languageCode: 'ml', name: '', slug: '', description: '', customFields: {} },
        ],
        customFields: { hsnCode: '04051000', productStockEnabled: false },
    },
};

const inputAfter = {
    input: {
        id: 731,
        enabled: true,
        featuredAssetId: 5693,
        assetIds: [5693],
        facetValueIds: [85],
        translations: [
            {
                id: 731,
                languageCode: 'en',
                name: 'Aavin butter unsalted ',
                slug: 'aavin-butter-unsalted-1',
                description: '<p>djknljkdn</p>',
                customFields: { localName: null },
            },
            {
                id: 778,
                languageCode: 'ta',
                name: '',
                slug: '',
                description: '',
                customFields: { localName: null },
            },
            {
                id: 779,
                languageCode: 'ml',
                name: '',
                slug: '',
                description: '',
                customFields: { localName: null },
            },
        ],
        customFields: { hsnCode: '04051000', productStockEnabled: false },
    },
};

describe('diffPayloads', () => {
    it('reports only the field that actually changed in a full-form resubmit', () => {
        const actual = toChangedPaths(diffPayloads(inputBefore, inputAfter));

        expect(actual).toContain('translations.en.description');
    });

    it('does not report enabled when it was merely resubmitted unchanged', () => {
        const actual = toChangedPaths(diffPayloads(inputBefore, inputAfter));

        expect(actual).not.toContain('enabled');
    });

    it('ignores translation ids that appear only because the first save created the row', () => {
        const actual = toChangedPaths(diffPayloads(inputBefore, inputAfter));

        expect(actual?.filter(path => path.endsWith('.id'))).toEqual([]);
    });

    it('reports enabled when it genuinely flips', () => {
        const disabled = { input: { id: 731, enabled: false } };
        const enabled = { input: { id: 731, enabled: true } };

        const actual = toChangedPaths(diffPayloads(disabled, enabled));

        expect(actual).toEqual(['enabled']);
    });

    it('matches translations by language rather than by position', () => {
        const before = {
            input: {
                translations: [
                    { languageCode: 'en', name: 'Butter' },
                    { languageCode: 'ta', name: 'வெண்ணெய்' },
                ],
            },
        };
        const reordered = {
            input: {
                translations: [
                    { languageCode: 'ta', name: 'வெண்ணெய்' },
                    { languageCode: 'en', name: 'Butter' },
                ],
            },
        };

        const actual = toChangedPaths(diffPayloads(before, reordered));

        expect(actual).toEqual([]);
    });

    it('reports a custom field edit under its own path', () => {
        const before = { input: { customFields: { localName: null } } };
        const after = { input: { customFields: { localName: 'வெண்ணெய்' } } };

        const actual = toChangedPaths(diffPayloads(before, after));

        expect(actual).toEqual(['customFields.localName']);
    });

    it('reports a translated custom field with its language', () => {
        const before = {
            input: { translations: [{ languageCode: 'ta', customFields: { localName: null } }] },
        };
        const after = {
            input: { translations: [{ languageCode: 'ta', customFields: { localName: 'பால்' } }] },
        };

        const actual = toChangedPaths(diffPayloads(before, after));

        expect(actual).toEqual(['translations.ta.customFields.localName']);
    });

    it('reports a keyless array under the array name rather than per index', () => {
        const before = { input: { assetIds: [1, 2] } };
        const after = { input: { assetIds: [1, 2, 3] } };

        const actual = toChangedPaths(diffPayloads(before, after));

        expect(actual).toEqual(['assetIds']);
    });

    it('reports a stock change on a variant update', () => {
        const before = { input: { id: 12, stockOnHand: 40, price: 25000 } };
        const after = { input: { id: 12, stockOnHand: 15, price: 25000 } };

        const actual = toChangedPaths(diffPayloads(before, after));

        expect(actual).toEqual(['stockOnHand']);
    });

    it('returns an empty list when a form is resaved with no edits', () => {
        const actual = toChangedPaths(diffPayloads(inputAfter, inputAfter));

        expect(actual).toEqual([]);
    });

    it('does not claim a field changed when the baseline never mentioned it', () => {
        // The product-stock toggle saves on its own with a two-field payload; the
        // Update button then sends the whole form. The fields the toggle omitted
        // are unobserved, not changed.
        const partialSave = { input: { id: 731, customFields: { productStockEnabled: true } } };
        const fullFormSave = {
            input: {
                id: 731,
                enabled: true,
                assetIds: [5693],
                customFields: { productStockEnabled: true, hsnCode: '04051000' },
            },
        };

        const actual = toChangedPaths(diffPayloads(partialSave, fullFormSave));

        expect(actual).toEqual([]);
    });

    it('still detects a real change among fields the baseline did mention', () => {
        const partialSave = { input: { id: 731, enabled: true } };
        const fullFormSave = { input: { id: 731, enabled: false, assetIds: [5693] } };

        const actual = toChangedPaths(diffPayloads(partialSave, fullFormSave));

        expect(actual).toEqual(['enabled']);
    });

    it('returns null when there is no baseline to compare against', () => {
        expect(diffPayloads(null, inputAfter)).toBeNull();
        expect(diffPayloads(undefined, inputAfter)).toBeNull();
    });

    describe('truncated payloads', () => {
        /**
         * These lock down a bug found in production data: `localName` was stored
         * as `[TRUNCATED_DEPTH]` because the depth cap was too shallow. Two
         * different values both serialised to that same marker, so the diff
         * compared them as equal and reported a real edit as no change.
         */
        it('stays silent about a field whose value was depth-truncated', () => {
            const before = {
                input: { translations: [{ languageCode: 'ta', customFields: { localName: '[TRUNCATED_DEPTH]' } }] },
            };
            const after = {
                input: { translations: [{ languageCode: 'ta', customFields: { localName: '[TRUNCATED_DEPTH]' } }] },
            };

            const actual = toChangedPaths(diffPayloads(before, after));

            expect(actual).toEqual([]);
        });

        it('does not report a change against a depth marker on one side only', () => {
            const before = { input: { customFields: { localName: '[TRUNCATED_DEPTH]' } } };
            const after = { input: { customFields: { localName: 'வெண்ணெய்' } } };

            const actual = toChangedPaths(diffPayloads(before, after));

            expect(actual).toEqual([]);
        });

        it('refuses to diff when a payload blew the byte cap', () => {
            const oversized = { _truncated: true, _originalBytes: 90_000, _preview: '{"input":' };
            const normal = { input: { id: 731, enabled: false } };

            expect(diffPayloads(oversized, normal)).toBeNull();
            expect(diffPayloads(normal, oversized)).toBeNull();
        });

        it('still reports untruncated siblings of a truncated field', () => {
            const before = {
                input: { enabled: true, customFields: { localName: '[TRUNCATED_DEPTH]' } },
            };
            const after = {
                input: { enabled: false, customFields: { localName: '[TRUNCATED_DEPTH]' } },
            };

            const actual = toChangedPaths(diffPayloads(before, after));

            expect(actual).toEqual(['enabled']);
        });
    });

    it('compares mutations whose arguments are not wrapped in an input field', () => {
        const before = { orderId: 5, quantity: 1 };
        const after = { orderId: 5, quantity: 3 };

        const actual = toChangedPaths(diffPayloads(before, after));

        expect(actual).toEqual(['quantity']);
    });
});

/**
 * The projection above is what the `changedFields` column stores. These lock
 * down the other half — the values the read side renders as "40 -> 400" — which
 * are computed by the same single comparison rather than a second one.
 */
describe('diffPayloads values', () => {
    it('carries the before and after value of a changed field', () => {
        const before = { input: { id: 12, price: 12500 } };
        const after = { input: { id: 12, price: 13000 } };

        const actual = diffPayloads(before, after);

        expect(actual).toEqual([{ path: 'price', from: 12500, to: 13000 }]);
    });

    it('reports a stock level per location rather than as two whole arrays', () => {
        // The real payloads of log rows 53 and 54 on variant #949, where the
        // operator raised the stock at location 2 from 40 to 400. Before
        // stockLocationId was matched as an array key this reported the entire
        // array on both sides, which is accurate and unreadable.
        const before = { input: { id: 949, stockLevels: [{ stockLocationId: 2, stockOnHand: 40 }] } };
        const after = { input: { id: 949, stockLevels: [{ stockLocationId: 2, stockOnHand: 400 }] } };

        const actual = diffPayloads(before, after);

        expect(actual).toEqual([{ path: 'stockLevels.2.stockOnHand', from: 40, to: 400 }]);
    });

    it('keeps a translated value under its language with both sides intact', () => {
        const before = { input: { translations: [{ languageCode: 'ta', name: 'பால்' }] } };
        const after = { input: { translations: [{ languageCode: 'ta', name: 'தயிர்' }] } };

        const actual = diffPayloads(before, after);

        expect(actual).toEqual([{ path: 'translations.ta.name', from: 'பால்', to: 'தயிர்' }]);
    });

    it('reports null on the missing side when an array member is added', () => {
        const before = { input: { stockLevels: [{ stockLocationId: 2, stockOnHand: 40 }] } };
        const after = {
            input: {
                stockLevels: [
                    { stockLocationId: 2, stockOnHand: 40 },
                    { stockLocationId: 3, stockOnHand: 5 },
                ],
            },
        };

        const actual = diffPayloads(before, after);

        expect(actual).toEqual([
            { path: 'stockLevels.3', from: null, to: { stockLocationId: 3, stockOnHand: 5 } },
        ]);
    });

    it('truncates a value too long to render on a timeline row', () => {
        const before = { input: { translations: [{ languageCode: 'en', description: '' }] } };
        const after = {
            input: { translations: [{ languageCode: 'en', description: 'x'.repeat(400) }] },
        };

        const actual = diffPayloads(before, after);

        expect(actual).toHaveLength(1);
        expect(actual?.[0].to).toBe(`${'x'.repeat(120)}\u2026`);
    });

    it('preserves primitive types so the reader is not handed stringified numbers', () => {
        const before = { input: { enabled: true, outOfStockThreshold: 0 } };
        const after = { input: { enabled: false, outOfStockThreshold: 5 } };

        const actual = diffPayloads(before, after);

        expect(actual).toEqual([
            { path: 'enabled', from: true, to: false },
            { path: 'outOfStockThreshold', from: 0, to: 5 },
        ]);
    });
});

describe('toChangedPaths', () => {
    it('narrows a rich diff to the paths the changedFields column stores', () => {
        const changes = [
            { path: 'enabled', from: true, to: false },
            { path: 'price', from: 1, to: 2 },
        ];

        expect(toChangedPaths(changes)).toEqual(['enabled', 'price']);
    });

    it('passes a null diff straight through, so no baseline still means no claim', () => {
        expect(toChangedPaths(null)).toBeNull();
    });
});
