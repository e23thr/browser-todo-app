/**
 * QA integrity probe (E2 core-UI card): is the committed a11y gate vacuous at HEAD?
 *
 * tests/e2e/a11y.spec.ts does NOT dismiss Epic E3's first-run screen, so on a fresh profile
 * every "core route" scan may only see the onboarding gate (cross-card finding from the
 * core-UI review t_3650ed00). This probe repeats the axe sweep with the durable ADR-002
 * onboarding marker set, i.e. against the REAL core views, and reports every violation.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { APP_URL, CORE_ROUTES } from './helpers';

test('axe scan of the real core views (onboarding pre-dismissed) — violation report', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    window.localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  });
  await page.goto(APP_URL);
  // Skipping the onboarding marker lands on E3's eviction-recovery panel instead ("storage
  // gone"); "Start fresh" then opens an inline confirm group — accept it to reach the shell.
  const startFresh = page.getByRole('button', { name: 'Start fresh', exact: true });
  const todayHeading = page.getByRole('heading', { name: 'Today', level: 1, exact: true });
  await expect(startFresh.or(todayHeading).first()).toBeVisible({ timeout: 20_000 });
  for (let i = 0; i < 3 && (await startFresh.count()) > 0; i += 1) {
    await startFresh.last().click();
    await page.waitForTimeout(500);
  }
  await expect(todayHeading).toBeVisible({ timeout: 20_000 });

  // Seed the way a user does (real composer) so populated states — group headers, rows,
  // badges — are what axe scans. Empty views hide the B1/B2 class of violations.
  // Zero-list profile: the composer offers "New list" inline (§16 item 16).
  await page.getByRole('button', { name: 'New list', exact: true }).first().click();
  const listDialog = page.getByRole('dialog', { name: 'New list', exact: true });
  await expect(listDialog).toBeVisible();
  const nameField = listDialog.getByRole('textbox', { name: 'List name', exact: true });
  await nameField.fill('QA scan');
  await nameField.press('Enter');
  await expect(listDialog).toBeHidden();
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await expect(title).toBeEnabled();
  await title.fill('First seeded task');
  await title.press('Enter');
  await title.fill('Second seeded task');
  await title.press('Enter');
  // Second list via the Manage-lists screen (the FAB/sheet path differs by viewport and is
  // M1–M4-covered elsewhere; the goal here is axe input, not flow coverage).
  await page.getByRole('link', { name: 'Manage lists', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Manage lists', level: 1, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'New list', exact: true }).first().click();
  await expect(listDialog).toBeVisible();
  await nameField.fill('QA scan two');
  await nameField.press('Enter');
  await expect(listDialog).toBeHidden();
  await page.getByRole('link', { name: 'All open', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'All open', level: 1, exact: true }),
  ).toBeVisible();

  const reported: string[] = [];
  for (const route of CORE_ROUTES) {
    await page.goto(`${APP_URL}${route}`);
    // The shell must actually be on the route, not the onboarding gate.
    await expect(page.locator('.onboarding, [data-onboarding]')).toHaveCount(0);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    for (const violation of results.violations) {
      reported.push(
        `${route === '' ? '/' : route} → ${violation.impact ?? 'unknown'}: ${violation.id} — ${violation.help} (${String(violation.nodes.length)} node(s))`,
      );
      for (const node of violation.nodes) {
        reported.push(`    ${node.target.join(' ')} :: ${node.html.slice(0, 220)}`);
      }
    }
  }
  console.warn(`AXE-REAL-VIEWS\n${reported.length === 0 ? '(none)' : reported.join('\n')}`);
});
