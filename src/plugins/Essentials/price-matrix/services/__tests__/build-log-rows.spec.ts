import { describe, it, expect } from 'vitest';
import { buildLogRows } from '../price-matrix.service';

describe('buildLogRows', () => {
    const meta = {
        variantNames: new Map([['10', 'Spring Onion 250g']]),
        channelNames: new Map([['2', 'Salem']]),
        oldPrices: new Map([['10:2', 4600]]),
        currencyByChannel: new Map([['2', 'INR']]),
        adminId: '7',
        adminName: 'sri ram',
    };

    it('emits a row for a changed cell with old->new + snapshot names', () => {
        const inputUpdates = [{ variantId: '10', channelId: '2', price: 5400 }];
        const actual = buildLogRows(inputUpdates, meta);
        expect(actual).toEqual([
            {
                variantId: '10',
                variantName: 'Spring Onion 250g',
                channelId: '2',
                channelName: 'Salem',
                oldPrice: 4600,
                newPrice: 5400,
                currencyCode: 'INR',
                adminId: '7',
                adminName: 'sri ram',
            },
        ]);
    });

    it('skips a cell whose price is unchanged (save-only-changed)', () => {
        const inputUpdates = [{ variantId: '10', channelId: '2', price: 4600 }];
        expect(buildLogRows(inputUpdates, meta)).toEqual([]);
    });

    it('logs oldPrice null when there was no prior price', () => {
        const inputUpdates = [{ variantId: '10', channelId: '2', price: 4600 }];
        const metaNoPrior = { ...meta, oldPrices: new Map<string, number>() };
        const actual = buildLogRows(inputUpdates, metaNoPrior);
        expect(actual[0].oldPrice).toBeNull();
    });

    it('falls back to "<unknown>" admin name when unresolved', () => {
        const inputUpdates = [{ variantId: '10', channelId: '2', price: 5400 }];
        const metaNoAdmin = { ...meta, adminId: undefined, adminName: '<unknown>' };
        const actual = buildLogRows(inputUpdates, metaNoAdmin);
        expect(actual[0].adminName).toBe('<unknown>');
        expect(actual[0].adminId).toBeUndefined();
    });
});
