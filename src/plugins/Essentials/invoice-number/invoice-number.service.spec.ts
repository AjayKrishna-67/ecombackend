import { Channel, Order, RequestContext, TransactionalConnection } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getFiscalYear, getFiscalYearShort } from './fiscal-year';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoiceSequence } from './invoice-sequence.entity';

vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

/**
 * Test customer (dedicated test account, NOT a real customer):
 *   phone: 8056305724
 * This is metadata only — the InvoiceNumberService doesn't touch customers,
 * so the phone is recorded on each fake Order to mirror how a real load
 * test would tag the originating customer.
 */
const TEST_CUSTOMER_PHONE = '8056305724';

interface FakeOrder {
    id: number;
    customFieldsInvoiceno: string | null;
    customerPhone: string;
    orderPlacedAt: Date;
    channelIds: number[];
}

/** Mirrors the MySQL driver's shape for a unique-index rejection. */
class FakeDuplicateKeyError extends Error {
    readonly code = 'ER_DUP_ENTRY';
    readonly errno = 1062;
}

/** Reads the trailing digits before the `|` — same as the service's SQL. */
function parseInvoiceNumber(invoiceNo: string): number {
    const beforePipe = invoiceNo.split('|')[0];
    const digits = /(\d+)$/.exec(beforePipe);
    return digits ? Number(digits[1]) : 0;
}

interface FakeSequence {
    groupKey: string;
    lastValue: number;
}

interface FakeChannel {
    id: number;
    code: string;
    customFields: { invoicePrefix?: string };
}

/**
 * Hand-crafted fake of TransactionalConnection that:
 *   - stores Order, InvoiceSequence, Channel rows in memory
 *   - simulates `setLock('pessimistic_write')` via a per-order async mutex
 *     (a second waiter blocks until the first releases, exactly like
 *     MySQL's `SELECT ... FOR UPDATE` on a row by primary key)
 *   - simulates the atomic `LAST_INSERT_ID(lastValue + 1)` UPDATE +
 *     `SELECT LAST_INSERT_ID()` pair via a per-connection counter
 *   - introduces a microtask yield on every read/write so that
 *     `Promise.all([...])` actually interleaves callers (without yields,
 *     JS single-threadedness would mask any race-condition bug).
 */
class FakeDb {
    orders = new Map<number, FakeOrder>();
    sequences = new Map<string, FakeSequence>();
    channels = new Map<number, FakeChannel>();
    private orderLocks = new Map<number, Promise<void>>();
    private sequenceLocks = new Map<string, Promise<void>>();

    async acquireOrderLock(id: number): Promise<() => void> {
        const previous = this.orderLocks.get(id) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>(resolve => {
            release = resolve;
        });
        this.orderLocks.set(id, previous.then(() => next));
        await previous;
        return release;
    }

    /**
     * Models `SELECT ... FOR UPDATE` on the invoice_sequence row: a second
     * caller for the same groupKey blocks until the first releases, which
     * happens once that caller's UPDATE has landed.
     */
    async acquireSequenceLock(key: string): Promise<() => void> {
        const previous = this.sequenceLocks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>(resolve => {
            release = resolve;
        });
        this.sequenceLocks.set(key, previous.then(() => next));
        await previous;
        return release;
    }

    async yield(): Promise<void> {
        await new Promise(resolve => setImmediate(resolve));
    }
}

function buildMockConnection(db: FakeDb): TransactionalConnection {
    const repo = (entity: any) => {
        if (entity === Order) {
            return buildOrderRepo(db);
        }
        if (entity === InvoiceSequence) {
            return buildSequenceRepo(db);
        }
        if (entity === Channel) {
            return buildChannelRepo(db);
        }
        throw new Error(`Unmocked entity: ${entity?.name}`);
    };
    return {
        getRepository: vi.fn().mockImplementation((_ctxOrEntity: any, maybeEntity?: any) => {
            return repo(maybeEntity ?? _ctxOrEntity);
        }),
        withTransaction: vi.fn().mockImplementation(async (_ctx: RequestContext, fn: any) => {
            return fn(_ctx);
        }),
    } as unknown as TransactionalConnection;
}

function buildOrderRepo(db: FakeDb) {
    return {
        findOne: async ({ where }: any) => {
            await db.yield();
            return db.orders.get(where.id) ?? null;
        },
        createQueryBuilder: (_alias?: string) => {
            const state: any = { lock: null, where: null, params: {}, action: 'select', set: null };
            const builder: any = {
                setLock: (mode: string) => {
                    state.lock = mode;
                    return builder;
                },
                select: (expr?: string) => {
                    state.selectExpr = expr ?? '';
                    return builder;
                },
                update: () => {
                    state.action = 'update';
                    return builder;
                },
                set: (data: any) => {
                    state.set = data;
                    return builder;
                },
                where: (_clause: string, params: any) => {
                    state.where = _clause;
                    Object.assign(state.params, params);
                    return builder;
                },
                andWhere: (_clause: string, params: any) => {
                    Object.assign(state.params, params);
                    return builder;
                },
                getRawOne: async () => {
                    await db.yield();
                    if (typeof state.selectExpr === 'string' && state.selectExpr.includes('MAX(')) {
                        // computeSeedValue: highest number issued across the
                        // channels in this sequence's group.
                        const channelIds: number[] = state.params.channelIds ?? [];
                        const numbers = [...db.orders.values()]
                            .filter(o => o.customFieldsInvoiceno !== null)
                            .filter(o => o.channelIds.some(id => channelIds.includes(id)))
                            .map(o => parseInvoiceNumber(o.customFieldsInvoiceno as string));
                        return { maxNum: numbers.length ? Math.max(...numbers) : null };
                    }
                    if (state.lock === 'pessimistic_write') {
                        // Lock is taken in the assignInvoiceNumber flow before any
                        // sequence change. We acquire here and release in a
                        // companion update/getRawOne in the same logical flow.
                        // Simpler model: hold lock for the duration of the test
                        // step by attaching release to the order itself.
                        const release = await db.acquireOrderLock(state.params.id);
                        const order = db.orders.get(state.params.id) ?? null;
                        // Release is invoked by the txCommit hook below; we stash
                        // it on the db keyed by orderId so the matching update
                        // can release it. With our naive model, release happens
                        // once the next .execute() on this order completes, OR
                        // when the order is observed to already have an invoice.
                        if (order?.customFieldsInvoiceno) {
                            release();
                            return { invoiceNo: order.customFieldsInvoiceno };
                        }
                        pendingReleases.set(state.params.id, release);
                        return { invoiceNo: null };
                    }
                    const order = db.orders.get(state.params.id) ?? null;
                    return order ? { invoiceNo: order.customFieldsInvoiceno } : null;
                },
                execute: async () => {
                    await db.yield();
                    if (state.action === 'update' && state.where === 'id = :id') {
                        const order = db.orders.get(state.params.id);
                        const incoming = state.set?.customFields?.invoiceNo;
                        // Unique index on the invoice number column: reject a
                        // value another order already holds. The lock is NOT
                        // released here — the caller retries inside the same
                        // transaction and still owns the order row.
                        const taken = [...db.orders.values()].some(
                            o => o.id !== state.params.id && o.customFieldsInvoiceno === incoming,
                        );
                        if (incoming && taken) {
                            throw new FakeDuplicateKeyError(`Duplicate entry '${incoming}'`);
                        }
                        if (order) {
                            order.customFieldsInvoiceno = incoming ?? order.customFieldsInvoiceno;
                        }
                        const release = pendingReleases.get(state.params.id);
                        if (release) {
                            pendingReleases.delete(state.params.id);
                            release();
                        }
                        return { affected: order ? 1 : 0 };
                    }
                    return { affected: 0 };
                },
                innerJoin: () => builder,
                addOrderBy: () => builder,
                orderBy: () => builder,
                getRawMany: async () => [],
            };
            return builder;
        },
    };
}

const pendingReleases = new Map<number, () => void>();

function buildSequenceRepo(db: FakeDb) {
    return {
        insert: async (data: FakeSequence) => {
            await db.yield();
            if (db.sequences.has(data.groupKey)) {
                throw new Error('Duplicate key');
            }
            db.sequences.set(data.groupKey, { ...data });
        },
        createQueryBuilder: (_alias?: string) => {
            const state: any = { params: {}, set: null, lock: null };
            const builder: any = {
                setLock: (mode: string) => {
                    state.lock = mode;
                    return builder;
                },
                update: () => builder,
                set: (data: any) => {
                    state.set = data;
                    return builder;
                },
                where: (_clause: string, params: any) => {
                    Object.assign(state.params, params);
                    return builder;
                },
                andWhere: (_clause: string, params: any) => {
                    Object.assign(state.params, params);
                    return builder;
                },
                getOne: async () => {
                    await db.yield();
                    const key = state.params.key;
                    if (state.lock !== 'pessimistic_write') {
                        return db.sequences.get(key) ?? null;
                    }
                    const release = await db.acquireSequenceLock(key);
                    const seq = db.sequences.get(key);
                    if (!seq) {
                        // Nothing to lock — the seed path runs next.
                        release();
                        return null;
                    }
                    pendingSequenceReleases.set(key, release);
                    // Mirror the MySQL driver returning bigint columns as
                    // strings, so the service's Number() coercion is exercised.
                    return { groupKey: seq.groupKey, lastValue: String(seq.lastValue) };
                },
                execute: async () => {
                    await db.yield();
                    const key = state.params.key;
                    const seq = db.sequences.get(key);
                    const release = pendingSequenceReleases.get(key);
                    if (!seq) {
                        if (release) {
                            pendingSequenceReleases.delete(key);
                            release();
                        }
                        return { affected: 0 };
                    }
                    // healSequence adds `lastValue < :seed`, so the write is
                    // conditional and only ever moves the counter forward.
                    const seedGuard = state.params.seed;
                    if (seedGuard !== undefined && !(seq.lastValue < Number(seedGuard))) {
                        if (release) {
                            pendingSequenceReleases.delete(key);
                            release();
                        }
                        return { affected: 0 };
                    }
                    seq.lastValue = Number(state.set?.lastValue ?? seq.lastValue);
                    if (release) {
                        pendingSequenceReleases.delete(key);
                        release();
                    }
                    return { affected: 1 };
                },
            };
            return builder;
        },
    };
}

const pendingSequenceReleases = new Map<string, () => void>();

function buildChannelRepo(db: FakeDb) {
    return {
        findOne: async ({ where }: any) => {
            await db.yield();
            return db.channels.get(where.id) ?? null;
        },
        find: async () => {
            await db.yield();
            return [...db.channels.values()];
        },
    };
}

function ctxFor(channelId: number): RequestContext {
    return { channelId } as unknown as RequestContext;
}

function buildOrder(id: number, channelIds: number[] = []): FakeOrder {
    return {
        id,
        customFieldsInvoiceno: null,
        customerPhone: TEST_CUSTOMER_PHONE,
        orderPlacedAt: new Date(),
        channelIds,
    };
}

describe('InvoiceNumberService', () => {
    let db: FakeDb;
    let service: InvoiceNumberService;

    beforeEach(() => {
        db = new FakeDb();
        db.channels.set(4, { id: 4, code: 'Madurai', customFields: { invoicePrefix: 'M-' } });
        db.channels.set(5, { id: 5, code: 'Salem', customFields: { invoicePrefix: 'S-' } });
        pendingReleases.clear();
        pendingSequenceReleases.clear();
        service = new InvoiceNumberService(buildMockConnection(db));
    });

    it('assigns {prefix}01|{fyShort} to the first order in a fresh fiscal year', async () => {
        db.orders.set(1, buildOrder(1));
        await service.assignInvoiceNumber(ctxFor(4), 1);
        const fy = getFiscalYear(new Date());
        const fyShort = getFiscalYearShort(new Date());
        expect(db.orders.get(1)!.customFieldsInvoiceno).toBe(`M-01|${fyShort}`);
        expect(db.sequences.get(`prefix:M-:fy:${fy}`)?.lastValue).toBe(1);
    });

    it('is idempotent: a second call on the same order does NOT increment the sequence', async () => {
        db.orders.set(1, buildOrder(1));
        await service.assignInvoiceNumber(ctxFor(4), 1);
        await service.assignInvoiceNumber(ctxFor(4), 1);
        const fy = getFiscalYear(new Date());
        const fyShort = getFiscalYearShort(new Date());
        expect(db.orders.get(1)!.customFieldsInvoiceno).toBe(`M-01|${fyShort}`);
        expect(db.sequences.get(`prefix:M-:fy:${fy}`)?.lastValue).toBe(1);
    });

    it('keeps per-channel sequences independent', async () => {
        db.orders.set(10, buildOrder(10));
        db.orders.set(11, buildOrder(11));
        await service.assignInvoiceNumber(ctxFor(4), 10);
        await service.assignInvoiceNumber(ctxFor(5), 11);
        const fy = getFiscalYear(new Date());
        const fyShort = getFiscalYearShort(new Date());
        expect(db.orders.get(10)!.customFieldsInvoiceno).toBe(`M-01|${fyShort}`);
        expect(db.orders.get(11)!.customFieldsInvoiceno).toBe(`S-01|${fyShort}`);
    });

    describe('shared prefix = shared sequence', () => {
        // Coimbatore was split into two delivery-zone channels. Both carry the
        // "C-" prefix, so both must draw from ONE running sequence — the
        // regression that shipped C-01 twice, once per zone.
        beforeEach(() => {
            db.channels.set(6, { id: 6, code: 'Coimbatore', customFields: { invoicePrefix: 'C-' } });
            db.channels.set(17, { id: 17, code: 'Coimbatore zone 2', customFields: { invoicePrefix: 'C-' } });
        });

        it('continues one sequence across both channels instead of restarting at 01', async () => {
            db.orders.set(20, buildOrder(20));
            db.orders.set(21, buildOrder(21));
            db.orders.set(22, buildOrder(22));
            await service.assignInvoiceNumber(ctxFor(6), 20);
            await service.assignInvoiceNumber(ctxFor(17), 21);
            await service.assignInvoiceNumber(ctxFor(6), 22);
            const fy = getFiscalYear(new Date());
            const fyShort = getFiscalYearShort(new Date());
            expect(db.orders.get(20)!.customFieldsInvoiceno).toBe(`C-01|${fyShort}`);
            expect(db.orders.get(21)!.customFieldsInvoiceno).toBe(`C-02|${fyShort}`);
            expect(db.orders.get(22)!.customFieldsInvoiceno).toBe(`C-03|${fyShort}`);
            expect(db.sequences.get(`prefix:C-:fy:${fy}`)?.lastValue).toBe(3);
        });

        it('issues no duplicates when both zones take orders concurrently', async () => {
            const zoneOneIds = Array.from({ length: 40 }, (_, i) => 4000 + i);
            const zoneTwoIds = Array.from({ length: 40 }, (_, i) => 5000 + i);
            for (const id of [...zoneOneIds, ...zoneTwoIds]) {
                db.orders.set(id, buildOrder(id));
            }
            await Promise.all([
                ...zoneOneIds.map(id => service.assignInvoiceNumber(ctxFor(6), id)),
                ...zoneTwoIds.map(id => service.assignInvoiceNumber(ctxFor(17), id)),
            ]);
            const fy = getFiscalYear(new Date());
            const fyShort = getFiscalYearShort(new Date());
            const suffix = `|${fyShort}`;
            const issued = [...zoneOneIds, ...zoneTwoIds].map(
                id => db.orders.get(id)!.customFieldsInvoiceno!,
            );
            expect(new Set(issued).size).toBe(80);
            const numeric = issued.map(s => Number(s.slice('C-'.length, -suffix.length))).sort((a, b) => a - b);
            expect(numeric[0]).toBe(1);
            expect(numeric[numeric.length - 1]).toBe(80);
            expect(db.sequences.get(`prefix:C-:fy:${fy}`)?.lastValue).toBe(80);
        });

        it('keeps prefix-less channels on separate sequences', async () => {
            // Two prefix-less channels each run their own counter (no merge),
            // but their rendered numbers are bare digits, so channel 16's "01"
            // is the same STRING as channel 1's "01". The unique index rejects
            // the second one and it heals to the next free number. Separate
            // sequences, shared number space — the argument for giving every
            // channel its own prefix.
            db.channels.set(1, { id: 1, code: 'default', customFields: {} });
            db.channels.set(16, { id: 16, code: 'International', customFields: { invoicePrefix: '  ' } });
            db.orders.set(30, buildOrder(30, [1]));
            db.orders.set(31, buildOrder(31, [16]));
            await service.assignInvoiceNumber(ctxFor(1), 30);
            await service.assignInvoiceNumber(ctxFor(16), 31);
            const fy = getFiscalYear(new Date());
            const fyShort = getFiscalYearShort(new Date());
            expect(db.orders.get(30)!.customFieldsInvoiceno).toBe(`01|${fyShort}`);
            expect(db.orders.get(31)!.customFieldsInvoiceno).toBe(`02|${fyShort}`);
            expect(db.sequences.get(`channel:1:fy:${fy}`)?.lastValue).toBe(1);
            expect(db.sequences.get(`channel:16:fy:${fy}`)?.lastValue).toBe(2);
        });
    });

    describe('sequence hand-edited below the issued numbers', () => {
        // Real incident: the sequence row was edited by hand to a value at or
        // below the highest invoice already issued. `lastValue` is trusted
        // blindly whenever the row exists, so every following order collided
        // with an existing invoice — repeatably, not as a race.
        const fy = getFiscalYear(new Date());
        const fyShort = getFiscalYearShort(new Date());

        beforeEach(() => {
            db.channels.set(6, { id: 6, code: 'Coimbatore', customFields: { invoicePrefix: 'C-' } });
            db.channels.set(17, { id: 17, code: 'Coimbatore zone 2', customFields: { invoicePrefix: 'C-' } });
            const issued = [
                { id: 900, num: 1995 },
                { id: 901, num: 1996 },
                { id: 902, num: 1997 },
            ];
            for (const { id, num } of issued) {
                const order = buildOrder(id, [6]);
                order.customFieldsInvoiceno = `C-${num}|${fyShort}`;
                db.orders.set(id, order);
            }
        });

        it('heals the counter and issues the next free number instead of a duplicate', async () => {
            db.sequences.set(`prefix:C-:fy:${fy}`, { groupKey: `prefix:C-:fy:${fy}`, lastValue: 1995 });
            db.orders.set(910, buildOrder(910, [17]));
            await service.assignInvoiceNumber(ctxFor(17), 910);
            expect(db.orders.get(910)!.customFieldsInvoiceno).toBe(`C-1998|${fyShort}`);
            expect(db.sequences.get(`prefix:C-:fy:${fy}`)?.lastValue).toBe(1998);
        });

        it('never reissues a number that is already on another order', async () => {
            db.sequences.set(`prefix:C-:fy:${fy}`, { groupKey: `prefix:C-:fy:${fy}`, lastValue: 1994 });
            const newIds = [920, 921, 922];
            for (const id of newIds) {
                db.orders.set(id, buildOrder(id, [17]));
            }
            for (const id of newIds) {
                await service.assignInvoiceNumber(ctxFor(id === 921 ? 6 : 17), id);
            }
            const all = [...db.orders.values()]
                .map(o => o.customFieldsInvoiceno)
                .filter((v): v is string => v !== null);
            expect(new Set(all).size).toBe(all.length);
            expect(newIds.map(id => db.orders.get(id)!.customFieldsInvoiceno)).toEqual([
                `C-1998|${fyShort}`,
                `C-1999|${fyShort}`,
                `C-2000|${fyShort}`,
            ]);
        });
    });

    describe('load: 100+ concurrent orders for customer 8056305724', () => {
        const ORDER_COUNT = 120;

        it('assigns 120 unique sequential invoice numbers with no gaps and no duplicates', async () => {
            const orderIds = Array.from({ length: ORDER_COUNT }, (_, i) => 1000 + i);
            for (const id of orderIds) {
                db.orders.set(id, buildOrder(id));
            }
            await Promise.all(
                orderIds.map(id => service.assignInvoiceNumber(ctxFor(4), id)),
            );
            const fy = getFiscalYear(new Date());
            const fyShort = getFiscalYearShort(new Date());
            const suffix = `|${fyShort}`;
            const issued = orderIds
                .map(id => db.orders.get(id)!.customFieldsInvoiceno)
                .filter((v): v is string => v !== null);
            expect(issued).toHaveLength(ORDER_COUNT);
            expect(new Set(issued).size).toBe(ORDER_COUNT);
            expect(issued.every(v => v.startsWith('M-') && v.endsWith(suffix))).toBe(true);
            const numeric = issued
                .map(s => Number(s.slice('M-'.length, -suffix.length)))
                .sort((a, b) => a - b);
            expect(numeric[0]).toBe(1);
            expect(numeric[numeric.length - 1]).toBe(ORDER_COUNT);
            for (let i = 1; i < numeric.length; i++) {
                expect(numeric[i] - numeric[i - 1]).toBe(1);
            }
            expect(db.sequences.get(`prefix:M-:fy:${fy}`)?.lastValue).toBe(ORDER_COUNT);
        });

        it('handles 50 concurrent calls on the SAME order without burning numbers', async () => {
            db.orders.set(42, buildOrder(42));
            await Promise.all(
                Array.from({ length: 50 }, () => service.assignInvoiceNumber(ctxFor(4), 42)),
            );
            const fy = getFiscalYear(new Date());
            const fyShort = getFiscalYearShort(new Date());
            expect(db.orders.get(42)!.customFieldsInvoiceno).toBe(`M-01|${fyShort}`);
            expect(db.sequences.get(`prefix:M-:fy:${fy}`)?.lastValue).toBe(1);
        });

        it('isolates 100 orders across two channels — each channel gets {prefix}NN|{fyShort} 01..50 independently', async () => {
            const maduraiIds = Array.from({ length: 50 }, (_, i) => 2000 + i);
            const salemIds = Array.from({ length: 50 }, (_, i) => 3000 + i);
            for (const id of [...maduraiIds, ...salemIds]) {
                db.orders.set(id, buildOrder(id));
            }
            await Promise.all([
                ...maduraiIds.map(id => service.assignInvoiceNumber(ctxFor(4), id)),
                ...salemIds.map(id => service.assignInvoiceNumber(ctxFor(5), id)),
            ]);
            const fy = getFiscalYear(new Date());
            const fyShort = getFiscalYearShort(new Date());
            const suffix = `|${fyShort}`;
            const mInvoices = maduraiIds.map(id => db.orders.get(id)!.customFieldsInvoiceno!);
            const sInvoices = salemIds.map(id => db.orders.get(id)!.customFieldsInvoiceno!);
            expect(new Set(mInvoices).size).toBe(50);
            expect(new Set(sInvoices).size).toBe(50);
            expect(mInvoices.every(v => v.startsWith('M-') && v.endsWith(suffix))).toBe(true);
            expect(sInvoices.every(v => v.startsWith('S-') && v.endsWith(suffix))).toBe(true);
            expect(db.sequences.get(`prefix:M-:fy:${fy}`)?.lastValue).toBe(50);
            expect(db.sequences.get(`prefix:S-:fy:${fy}`)?.lastValue).toBe(50);
        });
    });
});
