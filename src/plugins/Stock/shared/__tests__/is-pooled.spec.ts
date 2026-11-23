import { describe, expect, it } from 'vitest';

import { isPooled } from '../is-pooled';

describe('isPooled', () => {
    // The deadlock this exists for: the strategy read the toggle, the two
    // validators read only "does a pool row exist". A product with the toggle
    // off and a leftover row could be added to a cart (per-variant stock) and
    // never checked out (pool said 0).
    it('is false when the toggle is off, even with a pool row present', () => {
        expect(isPooled({ productStockEnabled: false }, true)).toBe(false);
        expect(isPooled({ productStockEnabled: 0 }, true)).toBe(false);
    });

    it('is false when the toggle is on but no pool row exists', () => {
        expect(isPooled({ productStockEnabled: true }, false)).toBe(false);
    });

    it('is true only when both the toggle and a pool row are present', () => {
        expect(isPooled({ productStockEnabled: true }, true)).toBe(true);
    });

    // MySQL hands boolean custom fields back as tinyint 1 — the same trap
    // isCustomFieldTrue exists for.
    it('accepts the MySQL tinyint 1 as on', () => {
        expect(isPooled({ productStockEnabled: 1 }, true)).toBe(true);
    });

    it('treats missing custom fields as off rather than throwing', () => {
        expect(isPooled(undefined, true)).toBe(false);
        expect(isPooled(null, true)).toBe(false);
        expect(isPooled({}, true)).toBe(false);
    });
});
