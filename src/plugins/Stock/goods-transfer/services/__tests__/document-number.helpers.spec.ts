import { describe, expect, it } from 'vitest';

import { DocumentKind } from '../../types';
import {
    buildSequenceGroupKey,
    formatDocumentNumber,
    getFiscalYearShort,
    getFiscalYearStartYear,
    padSequence,
    prefixFromChannelCode,
    resolveDocumentPrefix,
} from '../document-number.helpers';

describe('fiscal year (Indian FY, Apr 1 – Mar 31)', () => {
    it('April onwards belongs to the starting year', () => {
        expect(getFiscalYearStartYear(new Date('2026-04-01T00:00:00'))).toBe(2026);
        expect(getFiscalYearStartYear(new Date('2026-12-31T23:59:59'))).toBe(2026);
    });

    it('Jan–Mar belongs to the previous starting year', () => {
        expect(getFiscalYearStartYear(new Date('2026-03-31T23:59:59'))).toBe(2025);
        expect(getFiscalYearStartYear(new Date('2027-01-15T00:00:00'))).toBe(2026);
    });

    it('short label matches the existing invoice convention', () => {
        expect(getFiscalYearShort(new Date('2026-07-23'))).toBe('26-27');
        expect(getFiscalYearShort(new Date('2026-03-31'))).toBe('25-26');
        // century wrap safety
        expect(getFiscalYearShort(new Date('2099-05-01'))).toBe('99-00');
    });
});

describe('sequence key & padding', () => {
    it('builds the groupKey as {kind}:{channelId}:fy:{fy}', () => {
        expect(buildSequenceGroupKey(DocumentKind.TransferNumber, 3, '26-27')).toBe('transfer:3:fy:26-27');
        expect(buildSequenceGroupKey(DocumentKind.DamageNumber, '7', '26-27')).toBe('damage:7:fy:26-27');
    });

    it('pads to 4 by default and never truncates', () => {
        expect(padSequence(1)).toBe('0001');
        expect(padSequence(142)).toBe('0142');
        expect(padSequence(12345)).toBe('12345');
    });
});

describe('formatDocumentNumber', () => {
    it('formats the two numbers this module issues (PLAN.md §2.4)', () => {
        expect(formatDocumentNumber(DocumentKind.TransferNumber, 'KKM', 142, '26-27')).toBe(
            'TRF-KKM-0142|26-27',
        );
        expect(formatDocumentNumber(DocumentKind.DamageNumber, 'KKM', 27, '26-27')).toBe(
            'DMG-KKM-0027|26-27',
        );
    });

    it('keeps a transfer and a damage number apart at the same sequence value', () => {
        // Same branch, same year, both the seventh of their kind — the prefix letters
        // are the only thing separating them, so they have to.
        const transfer = formatDocumentNumber(DocumentKind.TransferNumber, 'KKM', 7, '26-27');
        const damage = formatDocumentNumber(DocumentKind.DamageNumber, 'KKM', 7, '26-27');
        expect(transfer).not.toBe(damage);
        expect(transfer).toBe('TRF-KKM-0007|26-27');
        expect(damage).toBe('DMG-KKM-0007|26-27');
    });

    it('falls back to GT when prefix missing', () => {
        expect(formatDocumentNumber(DocumentKind.TransferNumber, '', 5, '26-27')).toBe('TRF-GT-0005|26-27');
    });

    it('carries the fiscal year so April 1 cannot collide with the year before', () => {
        // The sequence restarts at 1 each FY (the group key contains the year), so
        // without |{fy} these two would be the same string and the unique constraint
        // would break transfer creation on April 1.
        const lastYear = formatDocumentNumber(DocumentKind.TransferNumber, 'MAD', 1, '25-26');
        const thisYear = formatDocumentNumber(DocumentKind.TransferNumber, 'MAD', 1, '26-27');
        expect(lastYear).not.toBe(thisYear);
        expect(thisYear).toBe('TRF-MAD-0001|26-27');
    });
});

describe('prefixFromChannelCode fallback', () => {
    it('uses the last code segment, 3 letters, uppercased', () => {
        expect(prefixFromChannelCode('ind-madurai')).toBe('MAD');
        expect(prefixFromChannelCode('ind-kochi')).toBe('KOC');
        expect(prefixFromChannelCode('covai')).toBe('COV');
        expect(prefixFromChannelCode('')).toBe('GT');
    });
});

describe('resolveDocumentPrefix (PLAN.md §2.4)', () => {
    it('prefers the channel invoicePrefix when it is set', () => {
        expect(resolveDocumentPrefix('M-', 'ind-madurai')).toBe('M-');
        expect(resolveDocumentPrefix('KKM', 'ind-kochi')).toBe('KKM');
    });

    it('falls back to the channel code when invoicePrefix is null, empty or blank', () => {
        expect(resolveDocumentPrefix(null, 'ind-madurai')).toBe('MAD');
        expect(resolveDocumentPrefix(undefined, 'ind-kochi')).toBe('KOC');
        expect(resolveDocumentPrefix('', 'ind-salem')).toBe('SAL');
        expect(resolveDocumentPrefix('   ', 'ind-trichy')).toBe('TRI');
    });

    it('keeps two prefix-less channels apart — the reason the fallback exists', () => {
        const madurai = formatDocumentNumber(
            DocumentKind.TransferNumber,
            resolveDocumentPrefix(null, 'ind-madurai'),
            1,
            '26-27',
        );
        const kochi = formatDocumentNumber(
            DocumentKind.TransferNumber,
            resolveDocumentPrefix(null, 'ind-kochi'),
            1,
            '26-27',
        );
        expect(madurai).not.toBe(kochi);
    });
});
