import { RequestContext, TransactionalConnection } from '@vendure/core';
import { FindOperator } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthenticationPhoneOtp } from '../entities/authentication-phone-otp.entity';

/**
 * SAFETY: the real SmsService.sendSms() POSTs to MSG91 and would send a
 * live SMS to the test number. A prior incident sent 100 real messages to
 * a real customer. This suite mocks BOTH the smsService module and axios
 * so ZERO network / SMS can ever leave the test process. The assertions
 * below explicitly verify nothing was sent.
 */
const sendSmsMock = vi.fn().mockResolvedValue({ message: 'mocked', type: 'success' });
const smsCtorMock = vi.fn();
const axiosPostMock = vi.fn();

vi.mock('../../../../smsService', () => ({
    SmsService: class {
        constructor(...args: unknown[]) {
            smsCtorMock(...args);
        }
        sendSms = sendSmsMock;
    },
}));

vi.mock('axios', () => ({
    default: { post: axiosPostMock, isAxiosError: () => false },
}));

// Imported AFTER mocks are registered so the service picks up the stubs.
import { PhoneOtpService } from './phone-otp.service';

/**
 * Dedicated test account (NOT a real customer). All assertions use this
 * number only; no other phone is ever touched.
 */
const TEST_CUSTOMER_PHONE = '8056305724';
const OTP_TTL_MS = 5 * 60_000;

interface StoredOtp extends AuthenticationPhoneOtp {
    id: number;
}

/** In-memory stand-in for the AuthenticationPhoneOtp repository. */
class FakeOtpDb {
    private rows = new Map<string, StoredOtp>(); // keyed by phoneNumber
    private nextId = 1;

    findOne(opts: { where: { phoneNumber: string } }): StoredOtp | undefined {
        return this.rows.get(opts.where.phoneNumber);
    }

    save(entity: AuthenticationPhoneOtp): StoredOtp {
        const existing = this.rows.get(entity.phoneNumber);
        const stored: StoredOtp = Object.assign(existing ?? { id: this.nextId++ }, entity);
        this.rows.set(entity.phoneNumber, stored);
        return stored;
    }

    delete(criteria: {
        phoneNumber: string;
        code: string;
        expiresAt: FindOperator<Date>;
    }): { affected: number } {
        const row = this.rows.get(criteria.phoneNumber);
        if (!row) return { affected: 0 };
        const minExclusive = (criteria.expiresAt as unknown as { value: Date }).value;
        const matches =
            row.code === criteria.code &&
            row.expiresAt != null &&
            row.expiresAt.getTime() > minExclusive.getTime();
        if (!matches) return { affected: 0 };
        this.rows.delete(criteria.phoneNumber);
        return { affected: 1 };
    }

    peek(phoneNumber: string): StoredOtp | undefined {
        return this.rows.get(phoneNumber);
    }

    expireRow(phoneNumber: string): void {
        const row = this.rows.get(phoneNumber);
        if (row) row.expiresAt = new Date(Date.now() - 1_000);
    }
}

function buildConnection(db: FakeOtpDb): TransactionalConnection {
    const repo = {
        findOne: vi.fn((opts: any) => Promise.resolve(db.findOne(opts))),
        save: vi.fn((entity: any) => Promise.resolve(db.save(entity))),
        delete: vi.fn((criteria: any) => Promise.resolve(db.delete(criteria))),
    };
    return {
        getRepository: vi.fn().mockReturnValue(repo),
    } as unknown as TransactionalConnection;
}

const ctx = {} as unknown as RequestContext;

describe('PhoneOtpService — account 8056305724 (SMS fully mocked, no real sends)', () => {
    let db: FakeOtpDb;
    let service: PhoneOtpService;

    beforeEach(() => {
        process.env.TOTP_SALT = 'test-salt';
        db = new FakeOtpDb();
        service = new PhoneOtpService(buildConnection(db), {} as any);
        sendSmsMock.mockClear();
        smsCtorMock.mockClear();
        axiosPostMock.mockClear();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('sendOtp stores a code and never sends a real SMS', async () => {
        const token = await service.sendOtp(ctx, TEST_CUSTOMER_PHONE);
        expect(token).toBeTruthy();
        const row = db.peek(TEST_CUSTOMER_PHONE);
        expect(row?.code).toBe(token);
        expect(row?.phoneNumber).toBe(TEST_CUSTOMER_PHONE);
        // expiresAt ~ now + 5 min
        const ttl = (row!.expiresAt as Date).getTime() - Date.now();
        expect(ttl).toBeGreaterThan(OTP_TTL_MS - 5_000);
        expect(ttl).toBeLessThanOrEqual(OTP_TTL_MS);
        // SAFETY assertions: stub used, real network never hit.
        expect(sendSmsMock).toHaveBeenCalledTimes(1);
        expect(axiosPostMock).not.toHaveBeenCalled();
    });

    it('verifyOtp succeeds with the issued code and consumes the row', async () => {
        const token = await service.sendOtp(ctx, TEST_CUSTOMER_PHONE);
        const verified = await service.verifyOtp(ctx, TEST_CUSTOMER_PHONE, token!);
        expect(verified).toBe(true);
        expect(db.peek(TEST_CUSTOMER_PHONE)).toBeUndefined(); // single-use
    });

    it('verifyOtp rejects a wrong code and keeps the row', async () => {
        await service.sendOtp(ctx, TEST_CUSTOMER_PHONE);
        const verified = await service.verifyOtp(ctx, TEST_CUSTOMER_PHONE, '0000');
        expect(verified).toBe(false);
        expect(db.peek(TEST_CUSTOMER_PHONE)).toBeDefined();
    });

    it('verifyOtp rejects an expired code', async () => {
        const token = await service.sendOtp(ctx, TEST_CUSTOMER_PHONE);
        db.expireRow(TEST_CUSTOMER_PHONE);
        const verified = await service.verifyOtp(ctx, TEST_CUSTOMER_PHONE, token!);
        expect(verified).toBe(false);
    });

    it('verifyOtp blocks after 10 attempts in the rate window', async () => {
        const token = await service.sendOtp(ctx, TEST_CUSTOMER_PHONE);
        for (let i = 0; i < 10; i++) {
            await service.verifyOtp(ctx, TEST_CUSTOMER_PHONE, 'wrong');
        }
        // 11th attempt is rate-limited even with the correct code.
        const verified = await service.verifyOtp(ctx, TEST_CUSTOMER_PHONE, token!);
        expect(verified).toBe(false);
    });

    it('resendOtp issues a fresh code and still sends no real SMS', async () => {
        await service.sendOtp(ctx, TEST_CUSTOMER_PHONE);
        sendSmsMock.mockClear();
        const token = await service.resendOtp(ctx, TEST_CUSTOMER_PHONE);
        expect(token).toBeTruthy();
        expect(db.peek(TEST_CUSTOMER_PHONE)?.code).toBe(token);
        expect(sendSmsMock).toHaveBeenCalledTimes(1);
        expect(axiosPostMock).not.toHaveBeenCalled();
    });
});
