/**
 * Offline app-shell suite (ADR-005 Decision 9, tests 1, 2, 6, 8, 9).
 *
 * Runs the REAL production pipeline output (fixture builds vA / root-vA) against a GitHub
 * Pages-like static server: no SPA rewrites, `sw.js` under the configured base path, unknown
 * paths 404 so the SW's navigation fallback is what must carry deep links.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { shouldPrecache } from '../../scripts/generate-precache.mjs';
import { BASE_PATH, cspViolations, installCspCollector } from './helpers';
import {
  BOOT_BUDGET_MS,
  cacheEntryUrls,
  completeFirstRunOnboarding,
  expectSingleVersionedCache,
  interactiveStartMs,
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

/** Every file the build ships, as absolute URLs — the generator's exclusion rules (Decision 2). */
function shippedArtifactUrls(distDir: string): string[] {
  const walk = (dir: string, prefix = ''): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(dir, rel));
      else out.push(rel);
    }
    return out;
  };
  return walk(distDir)
    .filter((rel) => shouldPrecache(rel))
    .map((rel) => `${server.origin}${BASE_PATH}${rel}`);
}

test('cold load online, then offline boot keeps the whole app working (M9)', async ({
  page,
  context,
}) => {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);

  // Precache = exactly one versioned cache holding the whole artifact set (Decision 2)…
  const cacheName = await expectSingleVersionedCache(page);
  const entries = await cacheEntryUrls(page, cacheName);
  expect(new Set(entries)).toEqual(new Set(shippedArtifactUrls(FIXTURES.vA)));
  // …including lazy chunks and locale packs, and nothing external or manifest-y (Q12/§7.2).
  expect(entries.filter((url) => url.endsWith('.webmanifest'))).toEqual([]);
  expect(entries.filter((url) => !url.startsWith(server.origin))).toEqual([]);

  // Network disabled: the shell boots from cache…
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();

  // …lazy routes work offline (whole-artifact precache is what M9 "offline-complete" means)…
  await page.goto(`${appUrl}#/settings`);
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();

  // …an unknown in-scope path falls back to the cached shell (Decision 4)…
  await page.goto(`${server.origin}${BASE_PATH}no-such-page`);
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();

  // …and repeated offline reloads keep working.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
});

test('warm and offline start-to-interactive stay inside the boot budget (§9.1)', async ({
  page,
  context,
}) => {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);

  // Warm (online, SW active): a reload is served cache-first.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  const warmMs = await interactiveStartMs(page);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  const offlineMs = await interactiveStartMs(page);

  test
    .info()
    .annotations.push(
      { type: 'boot', description: `warm start-to-interactive: ${warmMs.toFixed(1)} ms` },
      { type: 'boot', description: `offline start-to-interactive: ${offlineMs.toFixed(1)} ms` },
      { type: 'boot', description: `budget: ${String(BOOT_BUDGET_MS)} ms (§9.1 line: 300 ms)` },
    );

  expect(warmMs).toBeGreaterThan(0);
  expect(offlineMs).toBeGreaterThan(0);
  expect(warmMs).toBeLessThan(BOOT_BUDGET_MS);
  expect(offlineMs).toBeLessThan(BOOT_BUDGET_MS);
});

test('a failing update check is completely silent (Decision 6)', async ({ page, context }) => {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);

  server.setFailingSw(true);
  await triggerUpdateCheck(page);

  // No toast, no error UI — the app keeps serving the current version and stays usable.
  await page.waitForTimeout(1500);
  await expect(updateNotice(page)).toHaveCount(0);
  await page.goto(`${appUrl}#/settings`);
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();

  // Back on the shell document: an offline reload must keep working with zero UI.
  await page.goto(appUrl);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  await expect(updateNotice(page)).toHaveCount(0);
  server.setFailingSw(false);
});

test('scope and cache naming are correct under a root base path (Decision 8)', async ({
  page,
  context,
}) => {
  const rootServer = await startFixtureServer('/');
  rootServer.setRoot(FIXTURES.rootA);
  try {
    const rootUrl = `${rootServer.origin}/`;
    await page.goto(rootUrl);
    await waitForControlled(page);
    await completeFirstRunOnboarding(page);

    const scope = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistration())?.scope,
    );
    expect(scope).toBe(rootUrl);
    const name = await expectSingleVersionedCache(page);
    expect(name.startsWith('todo-shell:root:v:')).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  } finally {
    await rootServer.close();
  }
});

test('the non-root base path yields the scoped registration and cache namespace', async ({
  page,
}) => {
  await page.goto(appUrl);
  await waitForControlled(page);

  const scope = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistration())?.scope,
  );
  expect(scope).toBe(appUrl);
  const name = await expectSingleVersionedCache(page);
  expect(name.startsWith('todo-shell:browser-todo-app:v:')).toBe(true);

  // The worker script itself lives at the base root (GitHub Pages cannot raise the scope).
  const swResponse = await page.evaluate(async (url) => {
    const response = await fetch(url, { cache: 'no-store' });
    return response.status;
  }, `${appUrl}sw.js`);
  expect(swResponse).toBe(200);
  expect(statSync(join(FIXTURES.vA, 'sw.js')).size).toBeGreaterThan(0);
});

test('no CSP violations fire across offline boot and lazy navigation (Decision 9, test 9)', async ({
  page,
  context,
}) => {
  await installCspCollector(page);
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();
  await page.goto(`${appUrl}#/settings`);
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
  ).toBeVisible();

  expect(await cspViolations(page)).toEqual([]);
});
