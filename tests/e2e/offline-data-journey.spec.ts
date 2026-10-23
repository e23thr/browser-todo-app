/**
 * Offline data journeys (M9 "offline-complete"; PROJECT_ANALYSIS §9.5's
 * `add -> complete -> reload -> data present` run offline).
 *
 * Two layers, deliberately:
 *
 * 1. The settings journey runs TODAY against the app's real persistence path (the ADR-002
 *    `settings` record through the storage layer) and proves: write while offline -> reload
 *    offline -> data present.
 * 2. The TASK journey (add -> complete -> reload -> data present) needs the E2 core-UI task
 *    editor (card t_a2c647e1), which does not exist yet — this file therefore self-skips that
 *    test with an explicit reason until the composer lands, and then runs unchanged.
 */

import { expect, test } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import { startFixtureServer, waitForControlled } from './sw-utils';

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

  // Activation gate: the composer ships with the E2 core-UI card (t_a2c647e1). Until then this
  // journey cannot run — it self-skips here with the dependency named instead of failing.
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  test.skip(
    (await composer.count()) === 0,
    'task composer not implemented yet — depends on E2 core UI (t_a2c647e1); this journey activates unchanged once the composer lands',
  );

  await context.setOffline(true);

  await composer.fill('Offline journey task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.getByText('Offline journey task', { exact: true });
  await expect(row).toBeVisible();

  await page.getByRole('checkbox', { name: 'Offline journey task', exact: true }).check();

  await page.reload();
  await expect(row).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Offline journey task', exact: true }),
  ).toBeChecked();
});
