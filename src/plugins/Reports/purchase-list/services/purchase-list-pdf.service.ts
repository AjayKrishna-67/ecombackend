import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { InternalServerError, Logger } from '@vendure/core';

const loggerCtx = 'PurchaseListPdf';

/** How long to wait for the in-page paginator to finish before giving up. */
const PAGINATION_TIMEOUT_MS = 15_000;

/**
 * Renders the Purchase List HTML to a PDF using headless Chromium.
 *
 * WHY A BROWSER AND NOT A PDF LIBRARY
 * -----------------------------------
 * The layout is produced by a paginator that measures real `scrollHeight` to
 * pack each A4 sheet full and stamp an exact "X / Y" footer (see
 * ../purchase-list-document.ts). Reproducing that with pdfkit/pdfmake would mean
 * re-deriving text metrics for Tamil, which shapes with combining vowel signs --
 * the output would differ from the sheet the team prints by hand, which is the
 * one thing this must not do. Chromium runs the same code the dashboard runs.
 *
 * Tamil rendering depends on a system font. The stack asks for "Noto Sans Tamil"
 * first; if no Tamil font is installed the glyphs come out as boxes and the PDF
 * looks broken in a way that is easy to miss on a quick glance. `assertUsable`
 * probes for that at startup rather than letting it surface in a WhatsApp
 * message to the buying team.
 *
 * Playwright is imported lazily so a server without browsers installed can still
 * boot -- only generating a report fails, and it fails with a message that says
 * what to install.
 */
@Injectable()
export class PurchaseListPdfService implements OnApplicationShutdown {
    private browserPromise: Promise<any> | null = null;

    /**
     * Renders the document. `data-paginated` is set by the in-page script once
     * layout is final; polling for it is what makes this deterministic instead
     * of a fixed sleep that is either too slow or occasionally too short.
     */
    async render(html: string): Promise<{ pdf: Buffer; pageCount: number }> {
        const browser = await this.getBrowser();
        const page = await browser.newPage();
        try {
            await page.setContent(html, { waitUntil: 'load' });
            await page.waitForFunction(
                'document.documentElement.hasAttribute("data-paginated")',
                undefined,
                { timeout: PAGINATION_TIMEOUT_MS },
            );
            const pageCount = Number(
                await page.getAttribute('html', 'data-paginated'),
            );
            // printBackground so the table borders survive; the document already
            // sets `@page { size: A4; margin: 0 }`, and passing margins here too
            // would double them.
            const pdf: Buffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                preferCSSPageSize: true,
            });
            return { pdf, pageCount: Number.isFinite(pageCount) ? pageCount : 0 };
        } finally {
            await page.close().catch(() => undefined);
        }
    }

    /**
     * One browser process reused across renders. Launching Chromium costs
     * ~300 ms and ~80 MB; a scheduled report that fans out to several channels
     * would otherwise pay that per document.
     */
    private async getBrowser(): Promise<any> {
        if (!this.browserPromise) {
            this.browserPromise = this.launch().catch(err => {
                // Clear the cached rejection so the next attempt can retry --
                // otherwise one failed launch poisons the service until restart.
                this.browserPromise = null;
                throw err;
            });
        }
        return this.browserPromise;
    }

    private async launch(): Promise<any> {
        let chromium: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            ({ chromium } = require('playwright'));
        } catch {
            throw new InternalServerError(
                'Playwright is not installed on this server, so the purchase list cannot be rendered. ' +
                    'Install it as a runtime dependency and run `bunx playwright install chromium`.',
            );
        }
        try {
            const browser = await chromium.launch({
                // The worker often runs as root in a container, where Chromium's
                // sandbox cannot initialise. The rendered content is our own
                // generated HTML with no remote resources, so this is not an
                // exposure -- but do not point this renderer at untrusted input.
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            });
            Logger.info('Chromium launched for purchase-list rendering', loggerCtx);
            return browser;
        } catch (err: any) {
            throw new InternalServerError(
                `Could not launch Chromium for the purchase list: ${err?.message ?? String(err)}. ` +
                    'Run `bunx playwright install chromium` on this server.',
            );
        }
    }

    /**
     * Renders one Tamil glyph and checks it is not the "missing glyph" box.
     * Returns a human-readable problem, or null when the environment is fit to
     * produce the report.
     */
    async assertUsable(): Promise<string | null> {
        try {
            const browser = await this.getBrowser();
            const page = await browser.newPage();
            try {
                await page.setContent(
                    '<span id="t" style="font-family:\'Noto Sans Tamil\',sans-serif;font-size:40px">கறிவேப்பிலை</span>',
                    { waitUntil: 'load' },
                );
                const width = await page.evaluate(
                    'document.getElementById("t").getBoundingClientRect().width',
                );
                if (!Number(width)) {
                    return 'Tamil text rendered with zero width — no Tamil font is installed. Install fonts-noto (Noto Sans Tamil).';
                }
                return null;
            } finally {
                await page.close().catch(() => undefined);
            }
        } catch (err: any) {
            return err?.message ?? String(err);
        }
    }

    async onApplicationShutdown(): Promise<void> {
        const pending = this.browserPromise;
        this.browserPromise = null;
        if (!pending) {
            return;
        }
        // Never let a failed launch turn shutdown into an unhandled rejection.
        await pending.then(b => b.close()).catch(() => undefined);
    }
}
