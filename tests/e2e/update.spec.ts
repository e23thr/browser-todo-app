/**
 * Update-flow suite (ADR-005 Decision 9, tests 3–5, 7).
 *
 * The two-build fixture server swaps build output at runtime — exactly what a GitHub Pages
 * deploy looks like (same origin, byte-different `sw.js`). `data-build-id` on `<html>` marks
 * which build is live, so "exactly one deliberate reload" is directly observable.
 */

import { expect, test, type Page } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import {
  cacheNames,
  countMainNavigations,
  expectSingleVersionedCache,
  noReloadMarkerPresent,
  plantNoReloadMarker,
  startFixtureServer,
  triggerUpdateCheck,
  updateNotice,
  waitForControlled,
} from './sw-utils';

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

/** Boot a page on build A with a claimed service-worker controller. */
async function bootBuildA(page: Page): Promise<void> {
  await page.goto(appUrl);
  await waitForControlled(page);
}

/** Deploy build B at the server and drive the update check to the waiting state. */
async function deployBAndWaitForToast(page: Page): Promise<void> {
  server.setRoot(FIXTURES.vB);
  await triggerUpdateCheck(page);
  await expect(page.getByText('Update available', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
}

test('update flow: detect -> toast -> apply on user action -> exactly one reload', async ({
  page,
}) => {
  await bootBuildA(page);
  const cacheA = await expectSingleVersionedCache(page);
  await expect(page.locator('html')).toHaveAttribute('data-build-id', 'vA');

  await deployBAndWaitForToast(page);

  // The toast is a polite live region with focusable actions (Decision 5). Scoped to the update
  // notice: the shell keeps its own `role="status"` announcer region.
  const region = updateNotice(page).getByRole('status');
  await expect(region).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();

  // Nothing may reload before the user acts (E9).
  await plantNoReloadMarker(page);
  await page.waitForTimeout(1000);
  expect(await noReloadMarkerPresent(page)).toBe(true);

  const navigations = countMainNavigations(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-build-id', 'vB', { timeout: 20_000 });
  expect(navigations()).toBe(1);

  // Old caches were purged on activate (Decision 3) — exactly one versioned cache remains.
  const cacheB = await expectSingleVersionedCache(page);
  expect(cacheB).not.toBe(cacheA);
  expect(await cacheNames(page)).not.toContain(cacheA);
});

test('E9: a mid-edit session is never force-reloaded; Apply flushes the draft first', async ({
  page,
}) => {
  await bootBuildA(page);

  // The REAL editor (E2 core UI): a fresh profile has no lists, so the composer stays
  // disabled until one exists (S3 `composer.needsList` + `list.action.new`).
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await page.getByLabel('List name', { exact: true }).fill('QA List');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // Uncommitted content in the composer's REAL title field: typed, never submitted.
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('Mid-edit draft');

  await deployBAndWaitForToast(page);
  await plantNoReloadMarker(page);
  await page.waitForTimeout(1000);

  // The toast appeared mid-edit and nothing reloaded; the draft is intact (E9).
  expect(await noReloadMarkerPresent(page)).toBe(true);
  await expect(composer).toHaveValue('Mid-edit draft');

  // Apply during the edit FLUSHES the draft through the ADR-002 storage layer, then
  // reloads exactly once (Decision 7 rule 2) — never a reload over unflushed content.
  const navigations = countMainNavigations(page);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-build-id', 'vB', { timeout: 20_000 });
  expect(navigations()).toBe(1);

  // The edit survived the reload: the flushed draft is durable and restorable (the All-open
  // view lists an undated capture in its "No due date" group — S2).
  await page.goto(`${appUrl}#/all`);
  await expect(page.getByRole('listitem').filter({ hasText: 'Mid-edit draft' })).toBeVisible();
});

test('E9 multi-tab: applying in one tab never reloads another', async ({ context }) => {
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await bootBuildA(pageA);
  await bootBuildA(pageB);
  await plantNoReloadMarker(pageA);
  await plantNoReloadMarker(pageB);

  await deployBAndWaitForToast(pageA);
  await pageA.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(pageA.locator('html')).toHaveAttribute('data-build-id', 'vB', { timeout: 20_000 });

  // Tab B: notice only — its marker survives and it reloads only on its own user's click.
  const appliedNotice = pageB
    .getByRole('status')
    .filter({ hasText: 'Updated — refresh when ready' });
  await expect(appliedNotice).toBeVisible({ timeout: 20_000 });
  await pageB.waitForTimeout(1000);
  expect(await noReloadMarkerPresent(pageB)).toBe(true);

  const navigations = countMainNavigations(pageB);
  await appliedNotice.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(pageB.locator('html')).toHaveAttribute('data-build-id', 'vB', { timeout: 20_000 });
  expect(navigations()).toBe(1);
});

test('stale-tab guard: a vanished lazy chunk is explained, never auto-fixed (Decision 3)', async ({
  context,
}) => {
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await bootBuildA(pageA);
  await bootBuildA(pageB);

  await deployBAndWaitForToast(pageA);
  await pageA.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(pageA.locator('html')).toHaveAttribute('data-build-id', 'vB', { timeout: 20_000 });

  // Tab B still runs build A: its first lazy-route import now hits a 404 (old hashed chunk gone).
  await plantNoReloadMarker(pageB);
  await pageB.goto(`${appUrl}#/settings`);
  // Two notices legitimately stack here (stale-tab guard + applied-elsewhere): scope to the
  // stale-tab one, which carries its own explicit Refresh.
  const staleNotice = pageB
    .getByRole('status')
    .filter({ hasText: 'The app was updated in another tab' });
  await expect(staleNotice).toBeVisible({ timeout: 20_000 });

  // Guarded state: explicit Refresh, no crash, and absolutely no reload on its own.
  await expect(staleNotice.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await pageB.waitForTimeout(1000);
  expect(await noReloadMarkerPresent(pageB)).toBe(true);
});
