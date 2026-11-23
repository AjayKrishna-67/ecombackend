import { describe, expect, it } from 'vitest';
import { EMPTY_MEASURE, toMeasure } from '../../../shared/measurement';
import {
    buildStockLogRow,
    StockLogMeta,
    StockLogRowInput,
} from '../location-stock.service';

const meta: StockLogMeta = {
    targetName: 'Tomato 250g',
    locationName: 'Madurai',
    adminId: 7,
    adminName: 'Asha Rao',
};

describe('buildStockLogRow', () => {
    it('returns null on a no-op write (old === new)', () => {
        const input: StockLogRowInput = {
            kind: 'variant',
            targetId: 1,
            unit: 'piece',
            oldOnHand: 12,
            newOnHand: 12,
            stockLocationId: 3,
        };
        expect(buildStockLogRow(input, meta)).toBeNull();
    });

    it('records a variant change with snapshotted names and base unit', () => {
        const input: StockLogRowInput = {
            kind: 'variant',
            targetId: 42,
            unit: 'piece',
            oldOnHand: null,
            newOnHand: 5,
            stockLocationId: 3,
        };
        const row = buildStockLogRow(input, meta);
        expect(row).toMatchObject({
            kind: 'variant',
            targetId: 42,
            targetName: 'Tomato 250g',
            locationName: 'Madurai',
            unit: 'piece',
            oldOnHand: null,
            newOnHand: 5,
            adminId: 7,
            adminName: 'Asha Rao',
        });
    });

    it('records a product-pool change in grams', () => {
        const input: StockLogRowInput = {
            kind: 'product-pool',
            targetId: 99,
            unit: 'g',
            oldOnHand: 1000,
            newOnHand: 1500,
            stockLocationId: 3,
        };
        const row = buildStockLogRow(input, meta);
        expect(row?.kind).toBe('product-pool');
        expect(row?.unit).toBe('g');
        expect(row?.oldOnHand).toBe(1000);
        expect(row?.newOnHand).toBe(1500);
    });

    it('defaults adminId to null when no admin resolved', () => {
        const input: StockLogRowInput = {
            kind: 'variant',
            targetId: 1,
            unit: 'piece',
            oldOnHand: 0,
            newOnHand: 3,
            stockLocationId: 3,
        };
        const row = buildStockLogRow(input, { targetName: 'X', locationName: 'Y', adminName: '<unknown>' });
        expect(row?.adminId).toBeNull();
        expect(row?.adminName).toBe('<unknown>');
    });
});

