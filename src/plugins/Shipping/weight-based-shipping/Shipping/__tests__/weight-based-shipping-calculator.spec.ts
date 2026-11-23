import { Injector, Order, RequestContext, ShippingMethod, TransactionalConnection } from '@vendure/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { weightBasedShippingCalculator } from '../weight-based-shipping-calculator';

/**
 * Drives the real calculator end to end -- arg parsing, the shared option
 * measure resolver, and the threshold maths -- with the database stubbed.
 *
 * Args mirror the South Mithai method: 50 g per step, ₹2 per step, ₹9 base.
 * Weight comes ONLY from ProductOption measureValue + measureUnit; the old
 * ProductVariant weight/stockUnit fields are gone.
 */
interface OptionSpec {
    measureValue: number | null;
    measureUnit: string | null;
}

/** Options the stubbed DB returns for variants that arrive unhydrated. */
const dbOptions = new Map<string, OptionSpec[]>();

const connection = {
    getRepository: () => ({
        createQueryBuilder: () => {
            let ids: string[] = [];
            const qb = {
                leftJoinAndSelect: () => qb,
                where: (_sql: string, params: { chunk: string[] }) => {
                    ids = params.chunk.map(String);
                    return qb;
                },
                getMany: async () =>
                    ids.map(id => ({ id, options: (dbOptions.get(id) ?? []).map(toOption) })),
            };
            return qb;
        },
    }),
} as unknown as TransactionalConnection;

const ctx = { channel: { pricesIncludeTax: false } } as unknown as RequestContext;

const ARGS = [
    { name: 'weightThreshold', value: '50' },
    { name: 'costPerThreshold', value: '2' },
    { name: 'grossAmount', value: '9' },
];

function toOption(spec: OptionSpec) {
    return { deletedAt: null, customFields: spec };
}

/** A variant with its options already loaded (the in-memory path). */
function hydrated(id: string, options: OptionSpec[], customFields: Record<string, unknown> = {}) {
    return { id, customFields, options: options.map(toOption) };
}

/** A variant whose options relation was never loaded (the DB path). */
function unhydrated(id: string) {
    return { id, customFields: {} };
}

function orderOf(lines: Array<{ variant: unknown; quantity: number }>): Order {
    return {
        id: 1,
        lines: lines.map(l => ({ productVariant: l.variant, quantity: l.quantity })),
    } as unknown as Order;
}

async function priceOf(order: Order): Promise<{ price: number; totalWeight: number }> {
    const result = (await weightBasedShippingCalculator.calculate(
        ctx,
        order,
        ARGS,
        {} as ShippingMethod,
    )) as unknown as { price: number; metadata: { totalWeight: number } };
    return { price: result.price, totalWeight: result.metadata.totalWeight };
}

const KG = { measureValue: 1, measureUnit: 'kg' };
const G250 = { measureValue: 250, measureUnit: 'g' };

describe('weightBasedShippingCalculator — option measurement only', () => {
    beforeAll(async () => {
        await weightBasedShippingCalculator.init({ get: () => connection } as unknown as Injector);
    });

    it('charges base + ceil(grams / 50) x ₹2 for a 1 kg option', async () => {
        const actual = await priceOf(orderOf([{ variant: hydrated('1', [KG]), quantity: 2 }]));
        // 2000 g -> 40 steps x 200 paise + 900 base
        expect(actual).toEqual({ price: 8900, totalWeight: 2000 });
    });

    it('rounds a partial step up', async () => {
        const actual = await priceOf(
            orderOf([{ variant: hydrated('2', [{ measureValue: 75, measureUnit: 'g' }]), quantity: 1 }]),
        );
        // 75 g -> 2 steps
        expect(actual).toEqual({ price: 1300, totalWeight: 75 });
    });

    it('reads the option from the database when it was not loaded', async () => {
        dbOptions.set('3', [{ measureValue: 0.5, measureUnit: 'kg' }]);
        const actual = await priceOf(orderOf([{ variant: unhydrated('3'), quantity: 1 }]));
        // 500 g -> 10 steps
        expect(actual).toEqual({ price: 2900, totalWeight: 500 });
    });

    it('adds 0 g for an unmeasured line but still charges the measured ones', async () => {
        const actual = await priceOf(
            orderOf([
                { variant: hydrated('4', [G250]), quantity: 3 },
                { variant: hydrated('5', []), quantity: 5 },
            ]),
        );
        // 750 g -> 15 steps
        expect(actual).toEqual({ price: 3900, totalWeight: 750 });
    });

    it('picks the weighed option when a counted option comes first', async () => {
        const variant = hydrated('6', [{ measureValue: 1, measureUnit: 'piece' }, { measureValue: 500, measureUnit: 'g' }]);
        expect(await priceOf(orderOf([{ variant, quantity: 1 }]))).toEqual({ price: 2900, totalWeight: 500 });
    });

    // An order with no weight at all ships FREE -- the ₹9 base is not charged
    // either. Every case below lands here.
    it.each([
        ['a leftover variant weight with no option', hydrated('7', [], { weight: 1000, stockUnit: 'kg' })],
        ['a litre option (no density table)', hydrated('8', [{ measureValue: 1, measureUnit: 'litre' }])],
        ['a box option (counted unit)', hydrated('9', [{ measureValue: 1, measureUnit: 'box' }])],
        ['a packet option (counted unit)', hydrated('10', [{ measureValue: 1, measureUnit: 'packet' }])],
        ['an option with no measureValue', hydrated('11', [{ measureValue: null, measureUnit: null }])],
    ])('ships free for %s', async (_label, variant) => {
        expect(await priceOf(orderOf([{ variant, quantity: 2 }]))).toEqual({ price: 0, totalWeight: 0 });
    });
});
