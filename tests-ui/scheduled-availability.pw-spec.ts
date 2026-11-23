import { expect, Page, test } from '@playwright/test';
import { DASHBOARD_BASE, loginToDashboard } from './support/login';

/**
 * Browser coverage for the Scheduled Availability dashboard extension.
 *
 * What this adds over the vitest e2e suite: that suite proves the API and the
 * applier are correct, and knows nothing about whether the extension is
 * registered, whether the route resolves, or whether clicking a weekday chip
 * changes anything. A dashboard extension can be entirely correct and still not
 * appear, because the plugin was never added to the compile list.
 *
 * Selectors are role- and label-based rather than CSS. A class name changes when
 * someone restyles a button; an accessible name changes only when the meaning
 * changes -- so these assertions fail for real reasons, not cosmetic ones.
 */
test.describe('Scheduled Availability dashboard', () => {
    test.beforeEach(async ({ page }) => {
        await loginToDashboard(page);
    });

    test('the schedules list route resolves and renders', async ({ page }) => {
        await page.goto(`${DASHBOARD_BASE}/availability-schedules`);

        // A button, not a link: the page renders <Button render={<Link/>}>, which
        // keeps the button role and delegates navigation. Worth knowing before
        // writing any selector against this page.
        await expect(page.getByRole('button', { name: /new schedule/i })).toBeVisible();
    });

    test('the new-schedule page opens as a page, not a dialog', async ({ page }) => {
        await page.goto(`${DASHBOARD_BASE}/availability-schedules/new`);

        // Positive assertion first, and not decoration: "there is no dialog" is
        // trivially true on a blank page or a 404, so on its own it passes for
        // the wrong reason. Prove the form rendered before proving how.
        await expect(page.getByText(/when it runs/i)).toBeVisible();

        // A dialog would put this content inside role="dialog". This page used to
        // be a modal, and that regression is invisible to every API-level test.
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page).toHaveURL(/availability-schedules\/new/);
    });

    test('weekday chips toggle and support multiple days per pattern', async ({ page }) => {
        await page.goto(`${DASHBOARD_BASE}/availability-schedules/new`);

        await chooseWeeklyFrequency(page);

        const friday = page.getByRole('button', { name: 'Friday' });
        const saturday = page.getByRole('button', { name: 'Saturday' });

        await expect(friday).toBeVisible();

        // aria-pressed is the contract the chips expose; see the CronBuilder
        // component, which sets it from the selected state.
        const fridayWasPressed = (await friday.getAttribute('aria-pressed')) === 'true';
        await friday.click();
        await expect(friday).toHaveAttribute(
            'aria-pressed',
            fridayWasPressed ? 'false' : 'true',
        );

        // The feature this test exists for: several days in one pattern, which
        // the single-day version of the builder could not express.
        if (fridayWasPressed) {
            await friday.click();
        }
        await saturday.click();
        await expect(friday).toHaveAttribute('aria-pressed', 'true');
        await expect(saturday).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByText(/2 days a week/i)).toBeVisible();
    });

    test('choosing no days blocks the pattern instead of saving an empty cron', async ({
        page,
    }) => {
        await page.goto(`${DASHBOARD_BASE}/availability-schedules/new`);

        await chooseWeeklyFrequency(page);
        await page.getByRole('button', { name: /^clear$/i }).first().click();

        // The guard that stops a 4-field cron reaching the worker at 22:00.
        await expect(page.getByText(/pick at least one day/i)).toBeVisible();
    });
});

/**
 * Switches the "Hide it" pattern from Every day to On chosen days, which is what
 * reveals the weekday chips.
 *
 * The mode select is deliberately untouched: RECURRING is already the default,
 * so driving it added a step that could fail without testing anything. The
 * frequency select is found by its current text rather than by index -- there
 * are four comboboxes on this page and none of them carries an accessible name,
 * so `.first()` silently grabbed the target-type select instead.
 */
async function chooseWeeklyFrequency(page: Page): Promise<void> {
    await page.getByRole('combobox').filter({ hasText: 'Every day' }).first().click();
    await page.getByRole('option', { name: /on chosen days/i }).click();
}
