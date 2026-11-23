import { describe, expect, it } from 'vitest';
import { decideConversionEvent } from './decide-conversion-event';

describe('decideConversionEvent', () => {
    it('records the conversion at the stage already sent', () => {
        expect(decideConversionEvent({ hasNudge: true, stagesSent: 2, alreadyConverted: false })).toEqual({ stage: 2 });
    });

    it('attributes stage 0 when nudged row exists but no message was sent yet', () => {
        expect(decideConversionEvent({ hasNudge: true, stagesSent: 0, alreadyConverted: false })).toEqual({ stage: 0 });
    });

    it('skips orders that were never nudged', () => {
        expect(decideConversionEvent({ hasNudge: false, stagesSent: 0, alreadyConverted: false })).toBeNull();
    });

    it('is idempotent — skips when a conversion was already recorded', () => {
        expect(decideConversionEvent({ hasNudge: true, stagesSent: 3, alreadyConverted: true })).toBeNull();
    });
});
