import { describe, expect, it } from 'vitest';
import { stageDelaySeconds } from './stage-delay-seconds';

describe('stageDelaySeconds', () => {
    it('converts hours', () => { expect(stageDelaySeconds({ delayValue: 12, delayUnit: 'hours' } as any)).toBe(43200); });
    it('converts days', () => { expect(stageDelaySeconds({ delayValue: 3, delayUnit: 'days' } as any)).toBe(259200); });
    it('converts seconds', () => { expect(stageDelaySeconds({ delayValue: 10, delayUnit: 'seconds' } as any)).toBe(10); });
});
