import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

/**
 * Browser tests for the React Dashboard.
 *
 * Deliberately does NOT start the app. The dashboard is a Vite frontend talking
 * to a Vendure server talking to MySQL; orchestrating all three from a test
 * runner turns any backend problem into an opaque browser timeout. Run
 * `bun run dev` yourself, then `bun run test:pw`.
 *
 * Set PW_BASE_URL to point at a different environment.
 *
 * This is an ORIGIN, with no path. Playwright resolves a leading-slash argument
 * to page.goto() against the origin and throws the rest of baseURL away, so a
 * baseURL of ".../dashboard" plus goto("/availability-schedules") silently
 * requests /availability-schedules and lands on Vite's "did you mean /dashboard"
 * page. Specs carry the /dashboard prefix themselves, where it is visible.
 */
const baseURL = process.env.PW_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
    testDir: './tests-ui',
    testMatch: '**/*.pw-spec.ts',

    // A dashboard action can involve a GraphQL round trip plus a table refetch.
    timeout: 60_000,
    expect: { timeout: 15_000 },

    // Never in local runs: a test that passes on retry is a flaky test, and
    // hiding that is how a broken selector survives for months. CI retries once
    // to absorb genuine infrastructure noise.
    retries: process.env.CI ? 1 : 0,
    fullyParallel: false,
    workers: 1,

    reporter: [
        ['list'],
        ['html', { outputFolder: 'reports/playwright', open: 'never' }],
        ['junit', { outputFile: 'reports/playwright/junit.xml' }],
        ['json', { outputFile: 'reports/playwright/results.json' }],
    ],

    use: {
        baseURL,
        // 'on-first-retry' would capture nothing locally, where retries are 0.
        // A failed run should always leave something to look at.
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
