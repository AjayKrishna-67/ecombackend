import { describe, expect, it, vi } from 'vitest';
import { AbandonedCartAdminResolver } from './abandoned-cart-admin.resolver';
import { AbandonedCartConfig } from '../types';

function validInput(): AbandonedCartConfig {
    return {
        enabled: true,
        minOrderValueMinor: 30000,
        costPerMessageMinor: 1500,
        stages: [
            { delayValue: 12, delayUnit: 'hours', templateName: 't1', language: 'en', bodyVars: [] },
            { delayValue: 3, delayUnit: 'days', templateName: 't2', language: 'en', bodyVars: [] },
            { delayValue: 7, delayUnit: 'days', templateName: 't3', language: 'en', bodyVars: [] },
        ],
    };
}

describe('AbandonedCartAdminResolver', () => {
    it('delegates a valid setAbandonedCartSettings to the service', async () => {
        const service = { writeConfig: vi.fn(async (_ctx, cfg) => cfg) } as any;
        const resolver = new AbandonedCartAdminResolver(service);
        const ctx: any = {};
        const result = await resolver.setAbandonedCartSettings(ctx, { input: validInput() });
        expect(service.writeConfig).toHaveBeenCalledOnce();
        expect(result.enabled).toBe(true);
    });

    it('propagates validation errors from the service', async () => {
        const service = { writeConfig: vi.fn(async () => { throw new Error('stage delays must be strictly ascending'); }) } as any;
        const resolver = new AbandonedCartAdminResolver(service);
        await expect(resolver.setAbandonedCartSettings({} as any, { input: validInput() })).rejects.toThrow(/ascending/i);
    });
});
