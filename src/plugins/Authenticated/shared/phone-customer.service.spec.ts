import {
    ChannelService,
    Customer,
    CustomerService,
    ExternalAuthenticationMethod,
    ExternalAuthenticationService,
    RequestContext,
    TransactionalConnection,
    User,
} from '@vendure/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhoneCustomerService } from './phone-customer.service';

/** Dedicated test number (not a real customer) — same one the OTP suite uses. */
const TEST_PHONE = '8056305724';

describe('PhoneCustomerService.findOrCreateUser', () => {
    const mockCtx = { channelId: 2, channel: { token: 'star-biriyani' } } as unknown as RequestContext;
    let mockCustomerRepo: { findOne: ReturnType<typeof vi.fn> };
    let mockAuthRepo: { findOne: ReturnType<typeof vi.fn> };
    let mockUserRepo: { save: ReturnType<typeof vi.fn> };
    let mockCustomerService: { findOneByUserId: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    let mockExternalAuth: { createCustomerAndUser: ReturnType<typeof vi.fn> };
    let service: PhoneCustomerService;

    beforeEach(() => {
        vi.stubEnv('PLACEHOLDER_EMAIL_DOMAIN', '');
        mockCustomerRepo = {
            findOne: vi.fn(async (opts: { where: { phoneNumber?: string } }) =>
                opts.where.phoneNumber ? null : { id: 6, channels: [] },
            ),
        };
        mockAuthRepo = { findOne: vi.fn().mockResolvedValue(null) };
        mockUserRepo = { save: vi.fn(async (user: User) => user) };
        mockCustomerService = {
            findOneByUserId: vi.fn().mockResolvedValue({ id: 6, customFields: {} }),
            update: vi.fn().mockResolvedValue({}),
        };
        mockExternalAuth = { createCustomerAndUser: vi.fn().mockResolvedValue({ id: 11, verified: true }) };
        const mockChannelService = {
            findAll: vi.fn().mockResolvedValue({ items: [{ id: 1 }] }),
            assignToChannels: vi.fn().mockResolvedValue(undefined),
        };
        const mockConnection = {
            getRepository: (_ctx: RequestContext, entity: unknown) => {
                if (entity === Customer) return mockCustomerRepo;
                if (entity === ExternalAuthenticationMethod) return mockAuthRepo;
                if (entity === User) return mockUserRepo;
                throw new Error(`unexpected repository ${String(entity)}`);
            },
        };
        service = new PhoneCustomerService(
            mockConnection as unknown as TransactionalConnection,
            mockCustomerService as unknown as CustomerService,
            mockExternalAuth as unknown as ExternalAuthenticationService,
            mockChannelService as unknown as ChannelService,
        );
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('logs into the existing customer that owns the phone, without creating anything', async () => {
        const expectedUser = { id: 9, verified: true };
        mockCustomerRepo.findOne.mockImplementation(async (opts: { where: { phoneNumber?: string } }) =>
            opts.where.phoneNumber ? { id: 5, phoneNumber: TEST_PHONE, user: expectedUser } : { id: 5, channels: [] },
        );
        const actualUser = await service.findOrCreateUser(mockCtx, {
            phoneNumber: TEST_PHONE,
            firstName: 'Ignored',
            lastName: '',
        });
        expect(actualUser).toBe(expectedUser);
        expect(mockExternalAuth.createCustomerAndUser).not.toHaveBeenCalled();
    });

    it('creates a new customer under the phoneOtp identity with the default kaikani.com placeholder', async () => {
        const actualUser = await service.findOrCreateUser(mockCtx, {
            phoneNumber: TEST_PHONE,
            firstName: 'Sriram',
            lastName: '',
        });
        expect(actualUser).toEqual({ id: 11, verified: true });
        expect(mockExternalAuth.createCustomerAndUser).toHaveBeenCalledWith(mockCtx, {
            strategy: 'phoneOtp',
            externalIdentifier: TEST_PHONE,
            verified: true,
            firstName: 'Sriram',
            lastName: '',
            emailAddress: `${TEST_PHONE}@kaikani.com`,
        });
    });

    it('uses PLACEHOLDER_EMAIL_DOMAIN when it is set', async () => {
        vi.stubEnv('PLACEHOLDER_EMAIL_DOMAIN', 'amburstarbriyani.com');
        await service.findOrCreateUser(mockCtx, { phoneNumber: TEST_PHONE, firstName: 'Sriram', lastName: '' });
        expect(mockExternalAuth.createCustomerAndUser).toHaveBeenCalledWith(
            mockCtx,
            expect.objectContaining({ emailAddress: `${TEST_PHONE}@amburstarbriyani.com` }),
        );
    });

    it('keeps a real email address when one is supplied', async () => {
        await service.findOrCreateUser(mockCtx, {
            phoneNumber: TEST_PHONE,
            firstName: 'Sriram',
            lastName: '',
            emailAddress: 'sriram@example.com',
        });
        expect(mockExternalAuth.createCustomerAndUser).toHaveBeenCalledWith(
            mockCtx,
            expect.objectContaining({ emailAddress: 'sriram@example.com' }),
        );
    });

    it('returns the winner when a concurrent request created the same phone first', async () => {
        const expectedUser = { id: 12, verified: true };
        mockExternalAuth.createCustomerAndUser.mockRejectedValue({ code: 'ER_DUP_ENTRY' });
        mockAuthRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ user: expectedUser });
        const actualUser = await service.findOrCreateUser(mockCtx, {
            phoneNumber: TEST_PHONE,
            firstName: 'Sriram',
            lastName: '',
        });
        expect(actualUser).toBe(expectedUser);
    });

    it('finds the account through the phoneOtp auth method when no customer row carries the phone', async () => {
        const expectedUser = { id: 13, verified: true };
        mockAuthRepo.findOne.mockResolvedValueOnce({ user: expectedUser });
        const actualUser = await service.findOrCreateUser(mockCtx, {
            phoneNumber: TEST_PHONE,
            firstName: 'Sriram',
            lastName: '',
        });
        expect(actualUser).toBe(expectedUser);
        expect(mockExternalAuth.createCustomerAndUser).not.toHaveBeenCalled();
        expect(mockAuthRepo.findOne).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ strategy: 'phoneOtp', externalIdentifier: TEST_PHONE }),
            }),
        );
    });

    it('rethrows errors that are not a duplicate-entry race', async () => {
        mockExternalAuth.createCustomerAndUser.mockRejectedValue(new Error('db down'));
        await expect(
            service.findOrCreateUser(mockCtx, { phoneNumber: TEST_PHONE, firstName: 'Sriram', lastName: '' }),
        ).rejects.toThrow('db down');
    });
});
