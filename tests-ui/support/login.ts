import { Page } from '@playwright/test';

/**
 * Vite serves the dashboard under this path (`base: '/dashboard'` in
 * vite.config.mts). Kept out of playwright.config's baseURL because
 * page.goto('/x') resolves against the origin and would discard it.
 */
export const DASHBOARD_BASE = '/dashboard';

/**
 * Signs into the Dashboard, unless the session is already authenticated.
 *
 * Credentials come from the environment rather than from the file: the same spec
 * has to run against a local database with dev credentials and, later, against a
 * staging environment with real ones. A hardcoded superadmin/superadmin would
 * quietly fail everywhere except one machine.
 *
 * Two things this has to get right, both learned the hard way:
 *
 * 1. The dashboard is a React app served by Vite. `page.goto` resolves while the
 *    body is still empty, so any immediate "is the login form showing?" check
 *    answers about a page that has not rendered yet -- and concludes, wrongly,
 *    that we are already signed in. Every assertion afterwards then runs against
 *    the login screen. Wait for the field, do not poll for it once.
 *
 * 2. Success is signalled by leaving /dashboard/login, and by a token appearing
 *    in localStorage under 'vendure-session-token'. Asserting on the URL alone
 *    is not enough on its own, but combined with the field disappearing it is a
 *    genuine signal -- unlike "the URL does not contain the word login", which
 *    was true before the form was ever submitted.
 */
export async function loginToDashboard(page: Page): Promise<void> {
    const username = process.env.SUPERADMIN_USERNAME;
    const password = process.env.SUPERADMIN_PASSWORD;

    if (!username || !password) {
        throw new Error(
            'SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD must be set (they live in .env). ' +
                'Playwright loads .env via playwright.config.ts.',
        );
    }

    await page.goto(`${DASHBOARD_BASE}/login`);

    const emailField = page.getByRole('textbox', { name: /email|username/i });
    try {
        await emailField.waitFor({ state: 'visible', timeout: 20_000 });
    } catch {
        // An authenticated session redirects away from /login, so the field never
        // appears. Nothing to do.
        return;
    }

    await emailField.fill(username);
    await page.getByRole('textbox', { name: /password/i }).fill(password);
    await page.getByRole('button', { name: /sign in|log in|login/i }).click();

    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30_000 });
    await page.waitForFunction(() => !!localStorage.getItem('vendure-session-token'), null, {
        timeout: 30_000,
    });
}
