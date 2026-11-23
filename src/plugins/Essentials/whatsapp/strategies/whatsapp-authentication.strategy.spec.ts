import { Injector, RequestContext } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WhatsappLoginService } from '../services/whatsapp-login.service';
import { EXPIRED_LINK_MESSAGE, WhatsappAuthenticationStrategy } from './whatsapp-authentication.strategy';

describe('WhatsappAuthenticationStrategy', () => {
    const mockCtx = {} as RequestContext;
    let mockLoginService: { consume: ReturnType<typeof vi.fn> };
    let mockPhoneCustomerService: { findOrCreateUser: ReturnType<typeof vi.fn> };
    let strategy: WhatsappAuthenticationStrategy;

    beforeEach(() => {
        mockLoginService = { consume: vi.fn() };
        mockPhoneCustomerService = { findOrCreateUser: vi.fn().mockResolvedValue({ id: 11 }) };
        const mockInjector = {
            get: (token: unknown) => (token === WhatsappLoginService ? mockLoginService : mockPhoneCustomerService),
        } as unknown as Injector;
        strategy = new WhatsappAuthenticationStrategy();
        strategy.init(mockInjector);
    });

    it('is exposed to GraphQL as the "whatsapp" input', () => {
        expect(strategy.name).toBe('whatsapp');
    });

    it('logs in the phone behind a valid link', async () => {
        mockLoginService.consume.mockResolvedValue({ phoneNumber: '8056305724', firstName: 'Sriram' });
        const actualUser = await strategy.authenticate(mockCtx, { token: 'secret' });
        expect(actualUser).toEqual({ id: 11 });
        expect(mockLoginService.consume).toHaveBeenCalledWith(mockCtx, 'secret');
        expect(mockPhoneCustomerService.findOrCreateUser).toHaveBeenCalledWith(mockCtx, {
            phoneNumber: '8056305724',
            firstName: 'Sriram',
            lastName: '',
        });
    });

    it('returns the expired-link message for a used, expired or unknown link', async () => {
        mockLoginService.consume.mockResolvedValue(null);
        const actualResult = await strategy.authenticate(mockCtx, { token: 'secret' });
        expect(actualResult).toBe(EXPIRED_LINK_MESSAGE);
        expect(mockPhoneCustomerService.findOrCreateUser).not.toHaveBeenCalled();
    });
});
