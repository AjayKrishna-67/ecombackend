import { describe, expect, it } from 'vitest';
import { validateAbandonedCartConfig } from './validate-config';
import { AbandonedCartConfig } from '../types';

function makeConfig(overrides: Partial<AbandonedCartConfig> = {}): AbandonedCartConfig {
    return {
        enabled: true,
        minOrderValueMinor: 30000,
        costPerMessageMinor: 0,
        stages: [
            { delayValue: 12, delayUnit: 'hours', templateName: 't1', language: 'en', bodyVars: [] },
            { delayValue: 3, delayUnit: 'days', templateName: 't2', language: 'en', bodyVars: [] },
            { delayValue: 7, delayUnit: 'days', templateName: 't3', language: 'en', bodyVars: [] },
        ],
        ...overrides,
    };
}

describe('validateAbandonedCartConfig', () => {
    it('accepts a valid config', () => { expect(() => validateAbandonedCartConfig(makeConfig())).not.toThrow(); });
    it('rejects negative min value', () => { expect(() => validateAbandonedCartConfig(makeConfig({ minOrderValueMinor: -1 }))).toThrow(/min/i); });
    it('allows non-ascending delays (gaps are independent per stage)', () => {
        const cfg = makeConfig();
        cfg.stages[1] = { delayValue: 1, delayUnit: 'hours', templateName: 't2', language: 'en', bodyVars: [] }; // 1h gap after a 12h stage 1 is fine
        expect(() => validateAbandonedCartConfig(cfg)).not.toThrow();
    });
    it('rejects an invalid unit', () => {
        const cfg = makeConfig();
        (cfg.stages[0] as any).delayUnit = 'weeks';
        expect(() => validateAbandonedCartConfig(cfg)).toThrow(/unit/i);
    });
    it('rejects a non-positive delayValue', () => {
        const cfg = makeConfig();
        cfg.stages[0].delayValue = 0;
        expect(() => validateAbandonedCartConfig(cfg)).toThrow(/positive/i);
    });
    it('rejects empty template when enabled', () => {
        const cfg = makeConfig();
        cfg.stages[0].templateName = '  ';
        expect(() => validateAbandonedCartConfig(cfg)).toThrow(/template/i);
    });
    it('allows empty templates when disabled', () => {
        const cfg = makeConfig({ enabled: false });
        cfg.stages.forEach(s => (s.templateName = ''));
        expect(() => validateAbandonedCartConfig(cfg)).not.toThrow();
    });
    it('requires exactly 3 stages', () => {
        const cfg = makeConfig();
        cfg.stages = cfg.stages.slice(0, 2);
        expect(() => validateAbandonedCartConfig(cfg)).toThrow(/3 stages/i);
    });
});
