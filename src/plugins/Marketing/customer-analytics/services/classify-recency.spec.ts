import { describe, expect, it } from 'vitest';
import { assertValidThresholds, classifyRecency, RecencyThresholds } from './classify-recency';

const thresholds: RecencyThresholds = { activeWithinDays: 30, atRiskUntilDays: 60 };

describe('classifyRecency', () => {
    it('returns NEVER when there is no last order', () => {
        const actual = classifyRecency(null, thresholds);
        expect(actual).toBe('NEVER');
    });

    it('returns ACTIVE at the lower edge (0 days)', () => {
        const actual = classifyRecency(0, thresholds);
        expect(actual).toBe('ACTIVE');
    });

    it('returns ACTIVE exactly on the active boundary (X days)', () => {
        const actual = classifyRecency(30, thresholds);
        expect(actual).toBe('ACTIVE');
    });

    it('returns AT_RISK one day past the active boundary (X+1)', () => {
        const actual = classifyRecency(31, thresholds);
        expect(actual).toBe('AT_RISK');
    });

    it('returns AT_RISK exactly on the at-risk boundary (Y days)', () => {
        const actual = classifyRecency(60, thresholds);
        expect(actual).toBe('AT_RISK');
    });

    it('returns CHURN one day past the at-risk boundary (Y+1)', () => {
        const actual = classifyRecency(61, thresholds);
        expect(actual).toBe('CHURN');
    });

    it('returns CHURN for very old orders', () => {
        const actual = classifyRecency(3650, thresholds);
        expect(actual).toBe('CHURN');
    });
});

describe('assertValidThresholds', () => {
    it('accepts thresholds where atRiskUntilDays > activeWithinDays', () => {
        expect(() => assertValidThresholds({ activeWithinDays: 30, atRiskUntilDays: 60 })).not.toThrow();
    });

    it('throws when atRiskUntilDays is not greater than activeWithinDays', () => {
        expect(() => assertValidThresholds({ activeWithinDays: 60, atRiskUntilDays: 30 })).toThrow();
    });

    it('throws when either threshold is negative', () => {
        expect(() => assertValidThresholds({ activeWithinDays: -1, atRiskUntilDays: 60 })).toThrow();
    });
});
