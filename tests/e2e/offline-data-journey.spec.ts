/**
 * Offline data journeys (M9 "offline-complete"; PROJECT_ANALYSIS §9.5's
 * `add -> complete -> reload -> data present` run offline).
 *
 * Two layers, deliberately:
 *
 * 1. The settings journey runs TODAY against the app's real persistence path (the ADR-002
 *    `settings` record through the storage layer) and proves: write while offline -> reload
 *    offline -> data present.
 * 2. The TASK journey (add -> complete -> reload -> data present) drives the E2 core-UI task
 *    editor (card t_a2c647e1). It kept its self-skipping probe from the days before the
 *    composer existed — it now passes the probe and runs; the skip only fires if the
 *    composer placeholder ever goes missing again.
 *
 * QA note (card t_be7f0810): the task journey is written to the BINDING design contract
 * (docs/design/core-domain.md) — S2 view membership, S3 composer states, F1 defaults, F3
 * completion semantics — because four contract details decide whether it can run at all:
 *
 *   a. zero lists -> the composer is DISABLED (`composer.needsList` + `list.action.new`), so a
 *      fresh profile must create a list first (S3 states);
 *   b. an undated capture lands in the "No due date" group of the All-open view — the Today view
 *      only lists `dueDate <= today` (S2 membership matrix), so the journey captures on `#/all`;
 *   c. the row checkbox's accessible name is `a11y.toggleTask` ("Mark \"{title}\" as complete"),
 *      NOT the bare title (S2 a11y), so the row is located by its visible title text and the
 *      checkbox scoped to it;
 *   d. completing a task collapses it out of open views after ~900 ms (F3), so "data present"
 *      after the reload is asserted in the Completed view, checked.
 */

import { expect, test } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import { completeFirstRunOnboarding, startFixtureServer, waitForControlled } from './sw-utils';

let server: StaticServer;
let appUrl = '';

test.beforeAll(async () => {
  await ensureFixtures({ basePath: BASE_PATH });
  server = await startFixtureServer(BASE_PATH);
  server.setRoot(FIXTURES.vA);
  appUrl = `${server.origin}${BASE_PATH}`;
});

test.afterAll(async () => {
  await server.close();
});

test('offline data journey: an offline write survives an offline reload', async ({
  page,
  context,
}) => {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);
  await context.setOffline(true);

  // Write while offline through the real settings surface…
  await page.goto(`${appUrl}#/settings`);
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // …reload offline (twice: plain reload + full boot) and the data is still there.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto(`${appUrl}#/settings`);
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
});

test('offline task journey: add -> complete -> reload -> data present (E2 core UI)', async ({
  page,
  context,
}) => {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);

  // Activation gate: the composer ships with the E2 core-UI card (t_a2c647e1). Until then this
  // journey cannot run — it self-skips here with the dependency named instead of failing. The
  // composer only renders once the store leaves its loading state, so let the shell settle
  // before probing (the probe and the skip reason below are unchanged).
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await composer.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined);
  test.skip(
    (await composer.count()) === 0,
    'task composer not implemented yet — depends on E2 core UI (t_a2c647e1); this journey activates unchanged once the composer lands',
  );

  await context.setOffline(true);

  // (a) A fresh profile has no lists and the composer is disabled until one exists
  //     (S3: `composer.needsList` hint + `list.action.new` button; dialog per S6/ListDialog).
  const newListButton = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newListButton.count()) > 0) {
    await newListButton.first().click();
    await page.getByLabel('List name', { exact: true }).fill('QA List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }

  // (b) Capture on the All-open view: an undated task is a member of its "No due date" group
  //     there (S2) — the Today view would never show it.
  await page.goto(`${appUrl}#/all`);
  await composer.fill('Offline journey task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // (c) Row-scoped lookups: the checkbox is named `a11y.toggleTask` ("Mark \"…\" as complete"),
  //     so it is found through its row, never by an exact title name.
  const row = page.getByRole('listitem').filter({ hasText: 'Offline journey task' });
  await expect(row).toBeVisible();

  // (d) Complete (optimistic) — F3: the row collapses out of the open view after ~900 ms…
  await row.getByRole('checkbox').check();
  await expect(row).toBeHidden({ timeout: 5_000 });

  // …reload offline and the data is present: the task is still completed.
  await page.reload();
  await page.goto(`${appUrl}#/completed`);
  const completedRow = page.getByRole('listitem').filter({ hasText: 'Offline journey task' });
  await expect(completedRow).toBeVisible();
  await expect(completedRow.getByRole('checkbox')).toBeChecked();
});
