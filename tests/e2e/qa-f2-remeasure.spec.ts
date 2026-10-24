/**
 * F-2 re-measurement after the review rework (b32cf9a): is the EFFECTIVE checkbox target
 * (label.task-check-hit, which natively toggles the input) ≥ 44×44 at 375 px?
 */
import { expect, test } from '@playwright/test';

import { APP_URL } from './helpers';

test.setTimeout(90_000);

test('effective .task-check target is the label wrapper — measure both', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript(() => {
    window.localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  });
  await page.goto(APP_URL);
  const startFresh = page.getByRole('button', { name: 'Start fresh', exact: true });
  for (let i = 0; i < 3 && (await startFresh.count()) > 0; i += 1) {
    await startFresh.last().click();
    await page.waitForTimeout(400);
  }
  // Compact viewport: seed through the empty-state/FAB sheet. A default list may already
  // exist after "Start fresh" — only create one when the sheet offers it.
  await page.getByRole('button', { name: 'Add task', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Add task', exact: true });
  await expect(sheet).toBeVisible();
  const newList = sheet.getByRole('button', { name: 'New list', exact: true });
  if ((await newList.count()) > 0) {
    await newList.click();
    const listDialog = page.getByRole('dialog', { name: 'New list', exact: true });
    const nameField = listDialog.getByRole('textbox', { name: 'List name', exact: true });
    await nameField.fill('Probe');
    await nameField.press('Enter');
    await expect(listDialog).toBeHidden();
  }
  const title = sheet.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('Measure me');
  await title.press('Enter');
  // D3 membership: an undated task is not a member of Today — go where the row lives.
  // (A route goto sidesteps the D6 capture sheet, which stays open by design.)
  await page.goto(`${APP_URL}#/all`);
  await expect(page.locator('.task-check-hit').first()).toBeVisible({ timeout: 10_000 });

  const measured = await page.evaluate(() => {
    const pick = (sel: string): string => {
      const el = document.querySelector(sel);
      if (el === null) return `${sel}: (absent)`;
      const r = el.getBoundingClientRect();
      return `${sel}: ${String(Math.round(r.width))}×${String(Math.round(r.height))}`;
    };
    return [pick('.task-check-hit'), pick('.task-check'), pick('.task-check + *')];
  });
  console.warn(`F2-REMEASURE ${JSON.stringify(measured)}`);

  const label = page.locator('.task-check-hit').first();
  const box = await label.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
