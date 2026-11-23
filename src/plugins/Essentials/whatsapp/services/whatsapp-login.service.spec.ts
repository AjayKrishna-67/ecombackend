import { RequestContext, TransactionalConnection } from '@vendure/core';
import { createHash } from 'crypto';
import { FindOperator } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WhatsappLoginToken } from '../entities/whatsapp-login-token.entity';
import { WhatsappLoginService } from './whatsapp-login.service';

const TEST_PHONE = '8056305724';
const LINK_TTL_MS = 30 * 60_000;

type Where = Record<string, unknown>;

/** In-memory stand-in for the WhatsappLoginToken repository. */
class FakeTokenDb {
    rows: WhatsappLoginToken[] = [];

    save(entity: WhatsappLoginToken): WhatsappLoginToken {
        this.rows.push(entity);
        return entity;
    }

    findOne(opts: { where: Where }): WhatsappLoginToken | null {
        return this.rows.find(row => matches(row, opts.where)) ?? null;
    }

    delete(where: Where): { affected: number } {
        const before = this.rows.length;
        this.rows = this.rows.filter(row => !matches(row, where));
        return { affected: before - this.rows.length };
    }
}

function matches(row: WhatsappLoginToken, where: Where): boolean {
    return Object.entries(where).every(([key, condition]) => {
        const value = (row as unknown as Record<string, unknown>)[key];
        if (condition instanceof FindOperator) {
            if (condition.type === 'lessThan') return (value as Date) < (condition.value as Date);
            if (condition.type === 'moreThan') return (value as Date) > (condition.value as Date);
            throw new Error(`FakeTokenDb: unsupported operator ${condition.type}`);
        }
        return value === condition;
    });
}

describe('WhatsappLoginService', () => {
    const mockCtx = {} as RequestContext;
    let db: FakeTokenDb;
    let service: WhatsappLoginService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
        db = new FakeTokenDb();
        const mockConnection = { getRepository: () => db } as unknown as TransactionalConnection;
        service = new WhatsappLoginService(mockConnection);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stores only the SHA-256 of the secret, never the secret itself', async () => {
        const actualSecret = await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        expect(actualSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(db.rows).toHaveLength(1);
        expect(db.rows[0].secretHash).toBe(createHash('sha256').update(actualSecret).digest('hex'));
        expect(JSON.stringify(db.rows[0])).not.toContain(actualSecret);
    });

    it('expires the link 30 minutes after issue', async () => {
        await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        expect(db.rows[0].expiresAt.getTime()).toBe(Date.now() + LINK_TTL_MS);
    });

    it('redeems a secret exactly once', async () => {
        const secret = await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        const actualFirst = await service.consume(mockCtx, secret);
        const actualSecond = await service.consume(mockCtx, secret);
        expect(actualFirst).toEqual({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        expect(actualSecond).toBeNull();
    });

    it('rejects a secret it never issued', async () => {
        await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        expect(await service.consume(mockCtx, 'A'.repeat(43))).toBeNull();
    });

    it('rejects a malformed secret without touching the database', async () => {
        const findOneSpy = vi.spyOn(db, 'findOne');
        expect(await service.consume(mockCtx, 'short')).toBeNull();
        expect(findOneSpy).not.toHaveBeenCalled();
    });

    it('lets only one of two simultaneous taps log in', async () => {
        const secret = await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        const [actualFirst, actualSecond] = await Promise.all([
            service.consume(mockCtx, secret),
            service.consume(mockCtx, secret),
        ]);
        expect([actualFirst, actualSecond].filter(result => result !== null)).toHaveLength(1);
    });

    it('keeps unexpired links when purging', async () => {
        const firstSecret = await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        vi.advanceTimersByTime(10 * 60_000);
        await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        expect(await service.consume(mockCtx, firstSecret)).toEqual({
            phoneNumber: TEST_PHONE,
            firstName: 'Sriram',
        });
    });

    it('rejects a secret once 30 minutes have passed', async () => {
        const secret = await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        vi.advanceTimersByTime(LINK_TTL_MS + 1);
        expect(await service.consume(mockCtx, secret)).toBeNull();
    });

    it('purges expired rows whenever a new link is issued', async () => {
        await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        vi.advanceTimersByTime(LINK_TTL_MS + 1);
        await service.issueVerified({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        expect(db.rows).toHaveLength(1);
    });
});
