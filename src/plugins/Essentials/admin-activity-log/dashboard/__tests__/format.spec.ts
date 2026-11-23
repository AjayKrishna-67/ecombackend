import { describe, expect, it } from 'vitest';
import {
    describeAction,
    describeChanges,
    formatChangeValue,
    formatGap,
    humaniseFieldPath,
    isDestructive,
    parseUserAgent,
} from '../format';
import type { AdminActivityLogRow } from '../queries';

function buildRow(overrides: Partial<AdminActivityLogRow> = {}): AdminActivityLogRow {
    return {
        id: '1',
        createdAt: '2026-08-14T10:00:00.000Z',
        operationName: 'updateProduct',
        entityType: 'Product',
        entityId: '731',
        targetCount: 1,
        payload: { input: { id: 731, enabled: true } },
        changedFields: null,
        changes: null,
        entityLabel: null,
        entityLink: null,
        outcome: 'SUCCESS',
        errorMessage: null,
        adminId: '1',
        adminName: 'sri ram',
        sessionId: '14068982',
        channelId: '1',
        ipAddress: '127.0.0.1',
        userAgent: null,
        durationMs: 4,
        isAuthEvent: false,
        ...overrides,
    };
}

describe('describeAction', () => {
    /**
     * The regression: the Dashboard resubmits the whole form, so an ordinary
     * edit to a live product still carries `enabled: true`. Reading that value
     * directly made the log announce "Enabled product #731" for an edit that
     * enabled nothing.
     */
    it('does not claim an enable when enabled was merely resubmitted', () => {
        const row = buildRow({ changedFields: ['translations.en.description'] });

        expect(describeAction(row)).toBe('Updated product #731');
    });

    it('claims an enable only when the diff confirms enabled changed', () => {
        const row = buildRow({ changedFields: ['enabled'] });

        expect(describeAction(row)).toBe('Enabled product #731');
    });

    it('reports a disable when enabled genuinely flipped to false', () => {
        const row = buildRow({
            payload: { input: { id: 731, enabled: false } },
            changedFields: ['enabled'],
        });

        expect(describeAction(row)).toBe('Disabled product #731');
    });

    it('falls back to the operation name when there is no baseline', () => {
        const row = buildRow({ changedFields: null });

        expect(describeAction(row)).toBe('Updated product #731');
    });

    it('reports a delete from the operation name alone', () => {
        const row = buildRow({ operationName: 'deleteProducts', targetCount: 3, entityId: null });

        expect(describeAction(row)).toBe('Deleted product (3 items)');
    });

    it('names a sensitive read rather than inventing a verb', () => {
        const row = buildRow({ operationName: 'purchaseList', entityType: null, entityId: null });

        expect(describeAction(row)).toBe('Purchase List');
    });

    it('labels authentication events', () => {
        const row = buildRow({ operationName: 'LOGIN_FAILED', isAuthEvent: true });

        expect(describeAction(row)).toBe('Failed sign-in attempt');
    });
});

describe('isDestructive', () => {
    it('flags deletes', () => {
        expect(isDestructive(buildRow({ operationName: 'deleteProducts' }))).toBe(true);
    });

    it('flags a confirmed disable', () => {
        const row = buildRow({
            payload: { input: { enabled: false } },
            changedFields: ['enabled'],
        });

        expect(isDestructive(row)).toBe(true);
    });

    it('does not flag a resubmitted enabled:false on an already-off product', () => {
        const row = buildRow({
            payload: { input: { enabled: false } },
            changedFields: ['customFields.hsnCode'],
        });

        expect(isDestructive(row)).toBe(false);
    });
});

describe('describeChanges', () => {
    it('returns null when no baseline existed', () => {
        expect(describeChanges(buildRow({ changedFields: null }))).toBeNull();
    });

    it('returns an empty list when a form was resaved with no edits', () => {
        expect(describeChanges(buildRow({ changedFields: [] }))).toEqual([]);
    });

    it('labels every changed field', () => {
        const row = buildRow({ changedFields: ['enabled', 'customFields.hsnCode'] });

        expect(describeChanges(row)?.map(change => change.label)).toEqual(['Enabled', 'Hsn Code']);
    });

    it('carries the before and after values when the server derived them', () => {
        const row = buildRow({
            changedFields: ['stockLevels.2.stockOnHand'],
            changes: [{ path: 'stockLevels.2.stockOnHand', from: 40, to: 400 }],
        });

        expect(describeChanges(row)).toEqual([
            { label: 'Stock On Hand (location 2)', from: '40', to: '400' },
        ]);
    });

    /**
     * A path with no matching value must still be reported. The field name alone
     * says a change happened; dropping the row because its values could not be
     * read would hide the change entirely, which is strictly worse.
     */
    it('still names a field whose values could not be derived', () => {
        const row = buildRow({ changedFields: ['enabled'], changes: null });

        expect(describeChanges(row)).toEqual([{ label: 'Enabled', from: null, to: null }]);
    });

    /**
     * Locks down the mismatch that would otherwise hide every value on existing
     * rows: log row 54 was written with the path `stockLevels`, but today's diff
     * reports `stockLevels.2.stockOnHand`. Reading the labels off the stored
     * list would match neither and render "Stock Levels changed" with no values.
     */
    it('prefers the freshly derived diff over the stored path list', () => {
        const row = buildRow({
            changedFields: ['stockLevels'],
            changes: [{ path: 'stockLevels.2.stockOnHand', from: 40, to: 400 }],
        });

        expect(describeChanges(row)).toEqual([
            { label: 'Stock On Hand (location 2)', from: '40', to: '400' },
        ]);
    });

    it('returns every change and leaves truncation to the view', () => {
        const row = buildRow({ changedFields: ['a', 'b', 'c', 'd', 'e', 'f'] });

        expect(describeChanges(row)).toHaveLength(6);
    });
});

describe('describeAction target naming', () => {
    it('names the target instead of numbering it when a name is known', () => {
        const row = buildRow({
            entityType: 'ProductVariant',
            entityId: '949',
            entityLabel: 'MilkyMist Paneer 200gm',
            changedFields: ['stockLevels'],
        });

        expect(describeAction(row)).toBe('Updated product variant: MilkyMist Paneer 200gm');
    });

    it('falls back to the id when the payload carried no name', () => {
        const row = buildRow({ entityType: 'ProductVariant', entityId: '949' });

        expect(describeAction(row)).toBe('Updated product variant #949');
    });
});

describe('formatChangeValue', () => {
    it('spells out an absent value rather than rendering a blank beside the arrow', () => {
        expect(formatChangeValue(null)).toBe('\u2014');
        expect(formatChangeValue(undefined)).toBe('\u2014');
    });

    it('spells out an empty string, which is not the same as absent', () => {
        expect(formatChangeValue('')).toBe('(empty)');
    });

    it('reads booleans as the toggle an operator flipped', () => {
        expect(formatChangeValue(true)).toBe('yes');
        expect(formatChangeValue(false)).toBe('no');
    });

    it('keeps numbers as numbers', () => {
        expect(formatChangeValue(0)).toBe('0');
        expect(formatChangeValue(12500)).toBe('12500');
    });

    it('serialises a composite value it cannot phrase', () => {
        expect(formatChangeValue([1, 2])).toBe('[1,2]');
    });
});

describe('humaniseFieldPath', () => {
    it('phrases a per-location stock path instead of running the segments together', () => {
        expect(humaniseFieldPath('stockLevels.2.stockOnHand')).toBe('Stock On Hand (location 2)');
        expect(humaniseFieldPath('stockLevels.3')).toBe('Stock at location 3');
    });

    it('names a translated field with its language', () => {
        expect(humaniseFieldPath('translations.en.description')).toBe('Description (English)');
        expect(humaniseFieldPath('translations.ta.name')).toBe('Name (Tamil)');
    });

    it('drops customFields from the path, which operators never see', () => {
        expect(humaniseFieldPath('customFields.localName')).toBe('Local Name');
        expect(humaniseFieldPath('translations.ta.customFields.localName')).toBe(
            'Local Name (Tamil)',
        );
    });

    it('falls back to the raw language code for an unmapped language', () => {
        expect(humaniseFieldPath('translations.de.name')).toBe('Name (de)');
    });

    it('humanises a plain camelCase field', () => {
        expect(humaniseFieldPath('stockOnHand')).toBe('Stock On Hand');
    });
});

describe('parseUserAgent', () => {
    const cases: Array<[string, string, string, string, string]> = [
        [
            'Firefox on Ubuntu desktop',
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0',
            'Firefox 152',
            'Ubuntu',
            'Desktop',
        ],
        [
            'Firefox on Android phone',
            'Mozilla/5.0 (Android 16; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0',
            'Firefox 153',
            'Android',
            'Mobile',
        ],
        [
            'Chrome on Windows',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            'Chrome 140',
            'Windows 10/11',
            'Desktop',
        ],
        [
            'Safari on iPhone',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
            'Safari 18',
            'iOS',
            'Mobile',
        ],
        [
            'Safari on iPad reports as a tablet',
            'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1',
            'Safari 18',
            'iOS',
            'Tablet',
        ],
    ];

    for (const [name, userAgent, browser, os, deviceType] of cases) {
        it(`parses ${name}`, () => {
            const actual = parseUserAgent(userAgent);

            expect(actual?.browser).toBe(browser);
            expect(actual?.os).toBe(os);
            expect(actual?.deviceType).toBe(deviceType);
        });
    }

    it('prefers Edge over Chrome, which Edge also claims to be', () => {
        const edge =
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

        expect(parseUserAgent(edge)?.browser).toContain('Edge');
    });

    it('returns null when no user agent was captured', () => {
        expect(parseUserAgent(null)).toBeNull();
    });
});

describe('formatGap', () => {
    it('stays quiet below the idle threshold', () => {
        expect(formatGap('2026-08-14T10:00:00.000Z', '2026-08-14T10:20:00.000Z')).toBeNull();
    });

    it('reports a gap at or past the threshold', () => {
        expect(formatGap('2026-08-14T10:00:00.000Z', '2026-08-14T10:45:00.000Z')).toBe('45m idle');
    });

    it('switches to hours for a long break', () => {
        expect(formatGap('2026-08-14T10:00:00.000Z', '2026-08-14T13:30:00.000Z')).toBe(
            '3h 30m idle',
        );
    });
});
