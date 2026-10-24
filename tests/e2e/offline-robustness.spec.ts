/**
 * Offline robustness QA (test card t_be7f0810, epic E4) — degraded-network behaviour, cache
 * purge scoping, and the MVP install-scope decision (PO Q12).
 *
 * Scenario map:
 * - PROJECT_ANALYSIS §6.1 (zero network in the logic path; local writes never wait on the
 *   network), §9.1 (optimistic write feedback budget), §12 Q12 (no manifest / no install in MVP);
 * - ADR-005 Decision 3 (activate purges old VERSIONS of this app's shell cache), Decision 6
 *   (a failed update check is completely silent).
 *
 * Runs against the real production pipeline output (fixture build vA / vB) on the ADR-005
 * Decision 9 fixture server, exactly like tests/e2e/offline.spec.ts.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import {
  cacheEntryUrls,
  completeFirstRunOnboarding,
  expectSingleVersionedCache,
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

/**
 * Boot the app on build A with a claimed service-worker controller, past E3's first-run screen
 * (§7): a fresh profile is onboarding, not the shell, until "Get started" is taken — the same
 * first step every real user takes before any of these scenarios are about.
 */
async function bootBuildA(page: Page): Promise<void> {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);
}

/** Every shipped file of a fixture build, as dist-relative POSIX paths. */
function shippedFiles(distDir: string): string[] {
  const walk = (dir: string, prefix = ''): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(dir, rel));
      else out.push(rel);
    }
    return out;
  };
  return walk(distDir);
}

/**
 * Timestamp (performance.now()) at which `<html data-theme>` first became 'dark', recorded
 * in-page by a MutationObserver installed before the write — immune to Playwright polling lag.
 */
async function armThemeFeedbackProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as { __themeFeedbackAt: number | null };
    state.__themeFeedbackAt = null;
    const observer = new MutationObserver(() => {
      if (
        state.__themeFeedbackAt === null &&
        document.documentElement.dataset['theme'] === 'dark'
      ) {
        state.__themeFeedbackAt = performance.now();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  });
}

async function themeFeedbackAt(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window as unknown as { __themeFeedbackAt: number | null };
    return state.__themeFeedbackAt ?? -1;
  });
}

test('degraded network (2 s per response): local writes stay optimistic and durable (§6.1)', async ({
  page,
}) => {
  await bootBuildA(page);
  server.setLatency(2_000);
  try {
    await page.goto(`${appUrl}#/settings`);
    await expect(
      page.getByRole('heading', { name: 'Settings', level: 1, exact: true }),
    ).toBeVisible();

    // A local write must not wait for the network: with every response delayed 2 s, the
    // optimistic feedback budget (§9.1: add → visible < 100 ms) is still met.
    await armThemeFeedbackProbe(page);
    const clickedAt = await page.evaluate(() => performance.now());
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const feedbackMs = (await themeFeedbackAt(page)) - clickedAt;
    test.info().annotations.push({
      type: 'degraded',
      description: `optimistic write feedback with 2 s network latency: ${feedbackMs.toFixed(1)} ms (budget 100 ms)`,
    });
    expect(feedbackMs).toBeGreaterThan(0);
    expect(feedbackMs).toBeLessThan(100);

    // …and the write is durable offline of the network's health: a reload (served cache-first
    // by the SW) and a fresh boot of the settings view both show the value.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto(`${appUrl}#/settings`);
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();

    // No error surface appeared at any point.
    await expect(updateNotice(page)).toHaveCount(0);
  } finally {
    server.setLatency(0);
  }
});

test('degraded network (every response 500): writes persist and the update check is silent (Decision 6)', async ({
  page,
  context,
}) => {
  await bootBuildA(page);
  server.setFailingAll(true);
  try {
    // A failing update check is completely silent — no toast, no error UI (Decision 6)…
    await triggerUpdateCheck(page);
    await page.waitForTimeout(1_500);
    await expect(updateNotice(page)).toHaveCount(0);

    // …local writes still land and survive a reload…
    await page.goto(`${appUrl}#/settings`);
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // …and the failed check changed nothing about the shell caches.
    await expectSingleVersionedCache(page);
    await expect(updateNotice(page)).toHaveCount(0);
  } finally {
    server.setFailingAll(false);
    await context.setOffline(false);
  }
});

test('cache lifecycle: activate purges old VERSIONS of this app only (Decision 3)', async ({
  page,
}) => {
  await bootBuildA(page);
  const cacheA = await expectSingleVersionedCache(page);

  // Seed the cache store with this app's stale version and a DIFFERENT app's cache — both
  // plausible on one origin (GitHub Pages project pages share *.github.io).
  const staleName = `todo-shell:browser-todo-app:v:${'0'.repeat(16)}`;
  const foreignName = `todo-shell:other-app:v:${'1'.repeat(16)}`;
  await page.evaluate(
    async ({ stale, foreign }) => {
      const staleCache = await caches.open(stale);
      await staleCache.put('/stale-probe.txt', new Response('stale'));
      const foreignCache = await caches.open(foreign);
      await foreignCache.put('/foreign-probe.txt', new Response('foreign'));
    },
    { stale: staleName, foreign: foreignName },
  );

  try {
    server.setRoot(FIXTURES.vB);
    await triggerUpdateCheck(page);
    await expect(page.getByText('Update available', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-build-id', 'vB', { timeout: 20_000 });

    const names = await page.evaluate(async () => caches.keys());
    expect(names).not.toContain(cacheA); // old version purged on activate ✓
    expect(names).not.toContain(staleName); // stale version of THIS app purged ✓
    expect(names).toContain(foreignName); // a sibling app's cache must survive ✓ (purge scoped to this slug)
  } finally {
    server.setRoot(FIXTURES.vA);
  }
});

test('MVP install scope (PO Q12): no web manifest and no install prompt anywhere', async ({
  page,
}) => {
  await bootBuildA(page);

  // 1. the shell document ships no manifest link…
  const manifestLinks = await page.evaluate(
    () => document.querySelectorAll('link[rel="manifest"]').length,
  );
  expect(manifestLinks).toBe(0);

  // 2. …no manifest file is built, and no shipped script handles `beforeinstallprompt`…
  const files = shippedFiles(FIXTURES.vA);
  expect(files.filter((rel) => rel.endsWith('.webmanifest'))).toEqual([]);
  const installPromptRefs = files.filter(
    (rel) =>
      rel.endsWith('.js') &&
      readFileSync(join(FIXTURES.vA, rel), 'utf8').includes('beforeinstallprompt'),
  );
  expect(installPromptRefs).toEqual([]);

  // 3. …and nothing manifest-y was precached (ADR-005 Decision 2; Q12 supersedes M9's
  //    older "icons/manifest" wording).
  const cacheName = await expectSingleVersionedCache(page);
  const entries = await cacheEntryUrls(page, cacheName);
  expect(entries.filter((url) => url.endsWith('.webmanifest'))).toEqual([]);
});
