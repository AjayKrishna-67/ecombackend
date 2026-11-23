import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GT-01 enforced as a test, not as advice.
 *
 * The rule this module must never break is that source-branch stock is never
 * written. The way that is guaranteed is structural: only ONE file may reach a
 * stock-writing service, and that file writes exclusively to the destination
 * location.
 *
 * A comment saying so is advice a future change can ignore. This fails the build.
 *
 * If this test fails, do not add the new file to the allow-list. Route the call
 * through TransferStockService instead — that is the whole point. The only reason
 * to change the list is if the single writer is deliberately renamed or moved.
 */

const SERVICES_DIR = join(__dirname, '..');

/** The one file permitted to hold a reference to a stock-writing service. */
const THE_ONLY_STOCK_WRITER = 'transfer-stock.service.ts';

/**
 * Services that can change stock levels. Reaching either of these means the file
 * can change what a branch holds.
 */
const STOCK_WRITERS = ['StockLevelService', 'ProductStockService'];

/**
 * Strip comments so the checks below see code only.
 *
 * Every assertion here must tell a real reference apart from a mention in a comment.
 * Comments naming these things are useful — they are how the rule is explained at the
 * point it applies — and both checks in this file were tripped by their own
 * explanatory prose before this existed.
 */
function codeOnly(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments, including JSDoc
        .replace(/\/\/.*$/gm, ''); // line comments
}

/** Which stock-writing services this file actually references in code. */
function referencesStockWriter(source: string): string[] {
    const code = codeOnly(source);
    return STOCK_WRITERS.filter(name => new RegExp(`\\b${name}\\b`).test(code));
}

function serviceFiles(): string[] {
    return readdirSync(SERVICES_DIR).filter(f => f.endsWith('.service.ts'));
}

describe('GT-01: stock writes are confined to one file', () => {
    it('has services to check (guards against the glob silently finding nothing)', () => {
        // A test that scans zero files passes for the wrong reason.
        expect(serviceFiles().length).toBeGreaterThan(5);
        expect(serviceFiles()).toContain(THE_ONLY_STOCK_WRITER);
    });

    it('lets exactly one service reach a stock-writing service', () => {
        const offenders = serviceFiles()
            .filter(file => file !== THE_ONLY_STOCK_WRITER)
            .map(file => ({
                file,
                writers: referencesStockWriter(readFileSync(join(SERVICES_DIR, file), 'utf-8')),
            }))
            .filter(entry => entry.writers.length > 0);

        expect(
            offenders,
            offenders.length
                ? `These files can change stock levels directly, which breaks GT-01. ` +
                      `Route the call through TransferStockService instead of adding them here:\n` +
                      offenders.map(o => `  ${o.file} -> ${o.writers.join(', ')}`).join('\n')
                : '',
        ).toEqual([]);
    });

    it('confirms the permitted file really is the writer', () => {
        // The inverse assertion: if TransferStockService stopped holding these, the
        // test above would pass trivially while stock was being written elsewhere by
        // some means this check does not model.
        const source = readFileSync(join(SERVICES_DIR, THE_ONLY_STOCK_WRITER), 'utf-8');
        expect(referencesStockWriter(source).sort()).toEqual([...STOCK_WRITERS].sort());
    });

    it('keeps no source-side stock location on the transfer entity', () => {
        // The second half of GT-01: there is no field naming a source location, so
        // there is nothing for a future writer to aim at.
        const entity = codeOnly(
            readFileSync(join(SERVICES_DIR, '..', 'entities', 'goods-transfer.entity.ts'), 'utf-8'),
        );
        expect(entity).not.toMatch(/\bsourceStockLocationId\b/);
        expect(entity).toMatch(/\bdestinationStockLocationId\b/);
    });
});
