import { Injectable } from '@nestjs/common';
import { InternalServerError, LanguageCode, Logger, RequestContextService } from '@vendure/core';
import axios from 'axios';
import { lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PurchaseListService } from '../../../Reports/purchase-list/services/purchase-list.service';
import {
    countClosedDaysBefore,
    isClosedDay,
    MarketClosureConfig,
    shiftIsoDate,
} from '../functions/market-closure';
import { ReportStorageService } from './report-storage.service';
import {
    REPORT_SAMPLE_PDF_URL,
    REPORT_WHATSAPP_TEMPLATE,
    ReportDateRangeMode,
    ScheduledReportType,
} from '../constants';

const loggerCtx = 'ReportSender';

const MSG91_BULK_URL = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Where local debug copies of report PDFs live.
 *
 * Resolved through one function because two callers depend on it -- the writer
 * and the prune task. Inlined twice, an operator who sets REPORT_OUTPUT_DIR gets
 * a pruner that cheerfully sweeps the DEFAULT directory while the real one fills
 * up, and the logs would report success either way.
 */
export function resolveLocalReportDir(): string {
    return process.env.REPORT_OUTPUT_DIR ?? join(process.cwd(), 'static', 'reports');
}

export interface SendReportArgs {
    /** Channel the run belongs to — the RequestContext the report is read in. */
    channelToken: string;
    reportType: ScheduledReportType;
    dateRangeMode: ReportDateRangeMode;
    /** Channels the report aggregates. Passed through to the renderer. */
    reportChannelIds: string[];
    recipients: string[];
    /** IANA zone the rule runs in — decides what "today" means. */
    timezone: string;
    /** The brand's closure calendar. Empty means "never closed". */
    closureConfig: MarketClosureConfig;
}

export interface SendReportResult {
    documentUrl: string;
    recipientCount: number;
    note: string;
}

/** Returned instead of a send when the brand's market was shut on the run day. */
export interface ReportClosedResult {
    closed: true;
    reason: string;
}

/**
 * Renders a scheduled report and delivers it as a WhatsApp document.
 *
 * The rendering half is deliberately a seam rather than an implementation. The
 * purchase list is produced by a JavaScript paginator that measures scrollHeight
 * in a real browser, so reproducing it needs headless Chromium against the
 * delivery dashboard's own markup — a different process, in a different repo,
 * with its own font prerequisite. Until that exists, `resolveDocumentUrl`
 * returns a fixed sample so every other layer (schedule, sweep, grace window,
 * run history, MSG91 delivery) can be exercised and proven independently.
 */
@Injectable()
export class ReportSenderService {
    constructor(
        private readonly purchaseListService: PurchaseListService,
        private readonly requestContextService: RequestContextService,
        private readonly reportStorage: ReportStorageService,
    ) {}

    private readonly authKey = process.env.MSG91_AUTH_KEY ?? '';
    private readonly helloNumber = process.env.MSG91_HELLO_NUMBER ?? '';
    private readonly templateNamespace = process.env.MSG91_TEMPLATE_NAMESPACE ?? '';

    async sendReport(args: SendReportArgs): Promise<SendReportResult | ReportClosedResult> {
        // Named individually rather than as a pair: the run-history Detail column
        // is the only place an admin sees this, and "one of these two" sends them
        // to check both.
        const missing = [
            !this.authKey && 'MSG91_AUTH_KEY',
            !this.helloNumber && 'MSG91_HELLO_NUMBER',
        ].filter(Boolean);
        if (missing.length) {
            throw new InternalServerError(
                `Not set in the server environment: ${missing.join(', ')}. Scheduled reports cannot be sent until it is, and the worker must be restarted after the change.`,
            );
        }
        if (!args.recipients.length) {
            throw new InternalServerError('A report schedule must have at least one recipient');
        }

        // Resolved once, here, and handed down. Computing it again inside
        // resolveDocument would let the two copies drift, and the drift would be
        // invisible: both produce a plausible purchase list.
        const window = resolveClosureAwareWindow(
            args.dateRangeMode,
            args.timezone,
            args.closureConfig,
        );
        if (window.closed) {
            return { closed: true, reason: window.reason };
        }

        const { documentUrl, filename, note } = await this.resolveDocument(args, window);

        // Media components nest an object under a key named for the type, unlike
        // text components which carry a flat `value`. Getting this shape wrong
        // surfaces as a generic template error rather than a media error.
        const payload = {
            integrated_number: this.helloNumber,
            content_type: 'template',
            payload: {
                messaging_product: 'whatsapp',
                type: 'template',
                template: {
                    name: REPORT_WHATSAPP_TEMPLATE,
                    language: { code: 'en', policy: 'deterministic' },
                    namespace: this.templateNamespace,
                    to_and_components: [
                        {
                            to: args.recipients,
                            components: {
                                header_1: {
                                    type: 'document',
                                    value: documentUrl,
                                    filename,
                                },
                                body_date: {
                                    type: 'text',
                                    value: formatReportDate(args.timezone),
                                    parameter_name: 'date',
                                },
                            },
                        },
                    ],
                },
            },
        };

        const response = await axios.post(MSG91_BULK_URL, payload, {
            headers: { 'Content-Type': 'application/json', authkey: this.authKey },
            timeout: 30_000,
        });

        // MSG91 answers 200 with a body-level error for a rejected template, so
        // the HTTP status alone is not proof of delivery.
        const body = response.data as { type?: string; message?: string };
        if (body?.type && body.type !== 'success') {
            throw new InternalServerError(`MSG91 rejected the send: ${body.message ?? 'unknown error'}`);
        }

        Logger.info(
            `Sent ${args.reportType} to ${args.recipients.length} recipient(s)`,
            loggerCtx,
        );
        return { documentUrl, recipientCount: args.recipients.length, note };
    }

    /**
     * Produces the document to attach.
     *
     * Two halves, deliberately separate:
     *   GENERATE  real -- queries the catalogue and renders the actual PDF.
     *   PUBLISH   stubbed -- writes the file locally and hands MSG91 the sample
     *             URL, because Meta downloads the attachment ITSELF at send time
     *             and a local path is not reachable from the internet.
     *
     * Splitting them this way means the schedule, the date window, the row
     * maths, the render and the run history are all exercised for real now, and
     * object storage later changes exactly one function. The `note` carries the
     * real figures into the run-history Detail column, so an admin can see the
     * report was genuinely produced even while the link is still a placeholder.
     */
    private async resolveDocument(
        args: SendReportArgs,
        window: { from: Date; to: Date },
    ): Promise<{ documentUrl: string; filename: string; note: string }> {
        const now = new Date();
        const stamp = formatReportDate(args.timezone).replace(/\s+/g, '-');
        // What the recipient sees in WhatsApp. Stays clean and dateful -- the
        // display name is a separate field from the URL in the MSG91 payload,
        // so it does not have to carry the uniqueness the storage key needs.
        const filename = `${args.reportType.toLowerCase()}-${stamp}.pdf`;
        // What the object is called in S3. Carries the time so every run gets
        // its own URL; see ReportStorageService.publishPdf for why sharing one
        // is a delivery bug rather than merely untidy.
        const objectName = `${args.reportType.toLowerCase()}-${stamp}-${timeOfDayInZone(now, args.timezone)}.pdf`;

        if (args.reportType !== 'PURCHASE_LIST') {
            return {
                documentUrl: REPORT_SAMPLE_PDF_URL,
                filename,
                note: `No renderer for report type ${args.reportType}; sent the placeholder.`,
            };
        }

        const { from, to } = window;
        const ctx = await this.requestContextService.create({
            apiType: 'admin',
            channelOrToken: args.channelToken,
            languageCode: LanguageCode.en,
        });

        const { pdf, pageCount, report } = await this.purchaseListService.renderPurchaseListPdf(
            ctx,
            {
                from,
                to,
                // Never fall back to "all channels" -- an empty list here would
                // silently widen a Coimbatore report into every city's orders.
                channelIds: args.reportChannelIds.length ? args.reportChannelIds : undefined,
            },
            { timeZone: args.timezone },
        );

        // Local copy uses the unique name too, so a re-run leaves the earlier
        // sheet on disk to compare against instead of silently replacing it --
        // which is what made today's stale-attachment report hard to confirm.
        await this.writeLocalCopy(objectName, pdf);
        const detail =
            `${report.rows.length} row(s) from ${report.orderCount} order(s), ` +
            `${pageCount} page(s)` +
            (report.incompleteCount > 0
                ? `, ${report.incompleteCount} unmeasured (marked *)`
                : '');

        // Publish before returning: if the upload fails there is no point
        // sending, because Meta would attach nothing. Falling back to the
        // placeholder here would deliver a WRONG document that still looks like
        // a successful run -- worse than a visible failure, so this throws.
        const documentUrl = await this.reportStorage.publishPdf(
            objectName,
            pdf,
            isoDateInZone(now, args.timezone),
        );

        Logger.info(`Generated ${filename}: ${detail}`, loggerCtx);

        return { documentUrl, filename, note: `${detail}. ${documentUrl}` };
    }

    /**
     * Keeps the generated PDF on disk so it can be inspected before object
     * storage exists. Best-effort: failing to save a debug copy must never stop
     * a report going out.
     */
    private async writeLocalCopy(filename: string, pdf: Buffer): Promise<string> {
        const dir = resolveLocalReportDir();
        try {
            await mkdir(dir, { recursive: true });
            const target = join(dir, filename);
            await writeFile(target, pdf);
            return target;
        } catch (err: any) {
            Logger.warn(`Could not save a local copy of ${filename}: ${err?.message}`, loggerCtx);
            return '(not saved)';
        }
    }

    /**
     * Deletes local debug copies older than `retentionDays`.
     *
     * Scoped as narrowly as a delete can be: only the report directory, only its
     * own top level, only regular files, only `.pdf`. A pruner that recursed, or
     * that trusted the entry name, is one mis-set REPORT_OUTPUT_DIR away from
     * emptying whatever directory it was pointed at.
     *
     * Age comes from mtime rather than the timestamp in the filename. The name is
     * built from the RULE's timezone and is only a label; mtime is what the
     * filesystem guarantees, and a file whose name failed to parse would
     * otherwise be either kept forever or deleted immediately.
     *
     * Returns the number of files removed. Best-effort throughout: this runs on a
     * timer, and a single unreadable entry must not abandon the rest of the sweep.
     */
    async pruneLocalCopies(retentionDays: number): Promise<number> {
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
            return 0;
        }
        const dir = resolveLocalReportDir();
        const cutoff = Date.now() - retentionDays * MS_PER_DAY;
        const entries = await this.listReportFilenames(dir);
        let removed = 0;
        for (const entry of entries) {
            if (await this.deleteIfExpired(join(dir, entry), cutoff)) {
                removed++;
            }
        }
        if (removed > 0) {
            Logger.info(
                `Pruned ${removed} report PDF(s) older than ${retentionDays} day(s) from ${dir}`,
                loggerCtx,
            );
        }
        return removed;
    }

    /** Top-level `.pdf` names only. A missing directory is not an error -- no report has been written yet. */
    private async listReportFilenames(dir: string): Promise<string[]> {
        try {
            const entries = await readdir(dir);
            return entries.filter(entry => entry.toLowerCase().endsWith('.pdf'));
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                Logger.warn(`Could not read ${dir} to prune reports: ${err?.message}`, loggerCtx);
            }
            return [];
        }
    }

    /**
     * `lstat`, not `stat`: stat follows a symlink and would report the TARGET's
     * type and mtime, so a link into someone else's directory would look like an
     * ordinary old PDF. lstat describes the link itself, which fails `isFile()`
     * and is therefore skipped.
     */
    private async deleteIfExpired(target: string, cutoff: number): Promise<boolean> {
        try {
            const stats = await lstat(target);
            if (!stats.isFile() || stats.mtimeMs >= cutoff) {
                return false;
            }
            await unlink(target);
            return true;
        } catch (err: any) {
            Logger.warn(`Could not prune ${target}: ${err?.message}`, loggerCtx);
            return false;
        }
    }
}

/**
 * The order window a run covers, resolved in the RULE's timezone rather than the
 * server's.
 *
 * A 05:00 Asia/Kolkata run happens at 23:30 UTC the previous day, so deriving
 * "today" from the server clock would silently report the wrong day's orders --
 * and it would look right, because it would still be a plausible list.
 */
export function resolveReportWindow(
    mode: ReportDateRangeMode,
    timeZone: string,
    now: Date = new Date(),
): { from: Date; to: Date } {
    const today = dateInZone(now, timeZone);
    const target = mode === 'YESTERDAY' ? shiftIsoDate(today, -1) : today;
    const offset = zoneOffset(now, timeZone);
    return {
        from: new Date(`${target}T00:00:00.000${offset}`),
        to: new Date(`${target}T23:59:59.999${offset}`),
    };
}

/** Either the market was shut on the run day, or here is the window to report. */
export type ClosureAwareWindow =
    | { closed: true; reason: string }
    | { closed: false; from: Date; to: Date };

/**
 * The report window once the brand's closure calendar is taken into account.
 *
 * Two different days are in play and conflating them is the trap: the RUN day is
 * when the cron fires, the TARGET day is whose orders get listed, and `mode` is
 * the offset between them. A closed run day means no purchasing happened, so
 * nothing is sent. An open run day widens its window backwards by the number of
 * runs the closures swallowed -- which is why one formula serves both modes, and
 * why the YESTERDAY case needed no separate branch.
 */
export function resolveClosureAwareWindow(
    mode: ReportDateRangeMode,
    timeZone: string,
    config: MarketClosureConfig,
    now: Date = new Date(),
): ClosureAwareWindow {
    const runDay = dateInZone(now, timeZone);
    if (isClosedDay(runDay, config)) {
        return { closed: true, reason: `Market closed on ${runDay}; no purchase list sent.` };
    }
    const target = mode === 'YESTERDAY' ? shiftIsoDate(runDay, -1) : runDay;
    const missedRuns = countClosedDaysBefore(runDay, config);
    const start = shiftIsoDate(target, -missedRuns);
    const offset = zoneOffset(now, timeZone);
    return {
        closed: false,
        from: new Date(`${start}T00:00:00.000${offset}`),
        to: new Date(`${target}T23:59:59.999${offset}`),
    };
}

/**
 * The calendar date in the given zone.
 *
 * en-CA formats as YYYY-MM-DD, which is the only locale that gives a sortable
 * date without hand-assembling parts.
 */
export function dateInZone(at: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(at);
}

/**
 * HHMMSS in the given zone — the part that makes each run's storage key unique.
 *
 * Seconds, not just minutes: the "Run now" button and the sweep tick can land in
 * the same minute, and two runs sharing a URL is precisely the bug this exists to
 * prevent. Read in the rule's zone so the key sorts alongside its date folder.
 */
export function timeOfDayInZone(at: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    })
        .format(at)
        .replace(/\D/g, '');
}

/** YYYY-MM-DD in the given zone — the storage folder for the day's reports. */
export function isoDateInZone(at: Date, timeZone: string): string {
    // en-CA is the only common locale that formats as a sortable YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(at);
}


/** The zone's UTC offset at `at`, as "+05:30". */
function zoneOffset(at: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
        .formatToParts(at)
        .find(p => p.type === 'timeZoneName')?.value;
    // "GMT+05:30" -> "+05:30"; plain "GMT" (UTC) -> "+00:00".
    const match = parts?.match(/GMT([+-]\d{2}:\d{2})/);
    return match ? match[1] : '+00:00';
}

/** Today's date in the rule's own zone, which is what the recipient expects to read. */
function formatReportDate(timezone: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    }).format(new Date());
}
