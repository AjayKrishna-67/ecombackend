import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReportSenderService } from '../report-sender.service';

/**
 * These guard a DELETE. The prune task runs unattended against a directory an
 * operator can repoint with REPORT_OUTPUT_DIR, so "deletes the wrong thing" is
 * the failure that matters, not "deletes too little".
 *
 * The service is built with Object.create rather than `new`: pruneLocalCopies
 * touches no injected dependency, and constructing the real thing would drag in
 * the whole Nest container for a filesystem test.
 */
describe('ReportSenderService.pruneLocalCopies', () => {
    const service = Object.create(ReportSenderService.prototype) as ReportSenderService;
    let dir: string;
    let originalOutputDir: string | undefined;

    const DAY_MS = 24 * 60 * 60 * 1000;

    /** Writes a file and back-dates its mtime, which is what the pruner reads. */
    async function writeAged(name: string, ageInDays: number): Promise<string> {
        const target = join(dir, name);
        await writeFile(target, 'pdf-bytes');
        const at = new Date(Date.now() - ageInDays * DAY_MS);
        await utimes(target, at, at);
        return target;
    }

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'report-prune-'));
        originalOutputDir = process.env.REPORT_OUTPUT_DIR;
        process.env.REPORT_OUTPUT_DIR = dir;
    });

    afterEach(async () => {
        if (originalOutputDir === undefined) {
            delete process.env.REPORT_OUTPUT_DIR;
        } else {
            process.env.REPORT_OUTPUT_DIR = originalOutputDir;
        }
        await rm(dir, { recursive: true, force: true });
    });

    it('deletes PDFs older than the retention window and keeps the rest', async () => {
        await writeAged('purchase_list-old.pdf', 9);
        await writeAged('purchase_list-edge.pdf', 8);
        await writeAged('purchase_list-fresh.pdf', 2);

        const removed = await service.pruneLocalCopies(7);

        expect(removed).toBe(2);
        expect(await readdir(dir)).toEqual(['purchase_list-fresh.pdf']);
    });

    it('keeps a file exactly at the boundary', async () => {
        // mtime === cutoff must survive: an off-by-one here silently shortens
        // every operator's configured retention by a day.
        await writeAged('purchase_list-boundary.pdf', 0);

        expect(await service.pruneLocalCopies(7)).toBe(0);
        expect(await readdir(dir)).toContain('purchase_list-boundary.pdf');
    });

    it('ignores non-PDF files however old they are', async () => {
        await writeAged('notes.txt', 400);
        await writeAged('archive.zip', 400);

        expect(await service.pruneLocalCopies(7)).toBe(0);
        expect((await readdir(dir)).sort()).toEqual(['archive.zip', 'notes.txt']);
    });

    it('does not recurse into subdirectories', async () => {
        const nested = join(dir, 'archive');
        await mkdir(nested);
        const buried = join(nested, 'purchase_list-buried.pdf');
        await writeFile(buried, 'pdf-bytes');
        const at = new Date(Date.now() - 400 * DAY_MS);
        await utimes(buried, at, at);

        expect(await service.pruneLocalCopies(7)).toBe(0);
        expect(await readdir(nested)).toEqual(['purchase_list-buried.pdf']);
    });

    it('leaves symlinks alone even when they end in .pdf', async () => {
        const outside = join(dir, 'keep-me.dat');
        await writeFile(outside, 'not-a-report');
        const link = join(dir, 'purchase_list-link.pdf');
        await symlink(outside, link);
        const at = new Date(Date.now() - 400 * DAY_MS);
        await utimes(outside, at, at);

        expect(await service.pruneLocalCopies(7)).toBe(0);
        expect((await readdir(dir)).sort()).toEqual(['keep-me.dat', 'purchase_list-link.pdf']);
    });

    it('treats a zero or negative retention as "pruning disabled"', async () => {
        await writeAged('purchase_list-ancient.pdf', 400);

        expect(await service.pruneLocalCopies(0)).toBe(0);
        expect(await service.pruneLocalCopies(-1)).toBe(0);
        expect(await service.pruneLocalCopies(Number.NaN)).toBe(0);
        expect(await readdir(dir)).toEqual(['purchase_list-ancient.pdf']);
    });

    it('is a no-op when the directory does not exist yet', async () => {
        process.env.REPORT_OUTPUT_DIR = join(dir, 'never-created');

        await expect(service.pruneLocalCopies(7)).resolves.toBe(0);
    });
});
