import { describe, expect, it } from 'vitest';

import { visibleOrderLines } from './visible-order-lines';

describe('visibleOrderLines', () => {
    it('leaves out lines cancelled down to nothing', () => {
        const lines = [
            { id: '1', quantity: 2 },
            { id: '2', quantity: 0 },
            { id: '3', quantity: 1 },
        ];

        expect(visibleOrderLines(lines).map(l => l.id)).toEqual(['1', '3']);
    });

    it('keeps every line of an order with nothing cancelled', () => {
        const lines = [{ id: '1', quantity: 1 }];

        expect(visibleOrderLines(lines)).toEqual(lines);
    });

    it('treats a missing line list as empty', () => {
        expect(visibleOrderLines(undefined)).toEqual([]);
    });
});
