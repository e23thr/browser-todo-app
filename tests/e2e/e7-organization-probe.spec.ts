/**
 * E7 organization QA probes (test card t_ed1fa949, h_reviewer) — live-browser
 * evidence on REAL IndexedDB, complementary to the jsdom/fake-indexeddb suites:
 *
 *  1. Migration boot path (§5.4 M12): a literal v1 database (numeric priority,
 *     no tags field) through the REAL `boot()` + production registry in a real
 *     Chromium page — priorities remapped, pre-migration snapshot taken,
 *     zero quarantine, reboot idempotent. Asserts against APP_SCHEMA_VERSION
 *     (not a literal) so it stays valid as later cards add migration steps.
 *  2. Rename propagation at 10,000 tasks (S1 AC): the REAL `TaskRepo.sweepTag`
 *     one-transaction sweep timed on real IndexedDB. fake-indexeddb's update
 *     path is quadratic (impl disclosed 7.9 s @ 2k), so the emulated numbers
 *     are a substrate artifact — this is the truthful data point.
 *
 * Served by the ADR-005 fixture server from a per-worker build dir (sibling
 * cards build concurrently in this workspace — never the shared `dist/`).
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { APP_SCHEMA_VERSION } from '../../src/storage/schema';
import type { E7Harness } from './e7-organization/harness';
import type { StaticServer } from './fixtures/static-server.mjs';
import { startFixtureServer } from './sw-utils';

/** Type-only use so the `Window.__e7` augmentation in the harness is loaded. */
export type HarnessForTypes = E7Harness;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_CONFIG = 'tests/e2e/e7-organization/vite.config.mjs';
const OUT_DIR = resolve(
  REPO_ROOT,
  'tests',
  'e2e',
  '.fixtures',
  `e7-organization-${String(process.pid)}`,
);

let server: StaticServer;
let harnessUrl = '';

test.beforeAll(async () => {
  execFileSync('npx', ['vite', 'build', '--config', HARNESS_CONFIG, '--outDir', OUT_DIR], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  server = await startFixtureServer('/');
  server.setRoot(OUT_DIR);
  harnessUrl = `${server.origin}/index.html`;
});

test.afterAll(async () => {
  await server.close();
});

async function bootHarness(page: Page): Promise<void> {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => window.__e7.ready);
}

test('schema migration runs end-to-end in a real browser (priorities, snapshot, reboot)', async ({
  page,
}) => {
  await bootHarness(page);

  const dbName = `qa-e7-migrate-${String(Date.now())}`;
  const migrated = await page.evaluate((name) => window.__e7.seedV1AndMigrate(name), dbName);
  // eslint-disable-next-line no-console
  console.log('[e7-e2e] migration:', JSON.stringify(migrated));
  expect(migrated.ok).toBe(true);
  expect(migrated.migrated).toEqual({ from: 1, to: APP_SCHEMA_VERSION });
  expect(migrated.schemaVersion).toBe(APP_SCHEMA_VERSION);
  expect(migrated.snapshotId).not.toBeNull();
  expect(migrated.quarantined).toBe(0);

  // Meaning-preserving map: legacy High→P1, Medium→P2, Low→P3, unset→P4, garbage→P4.
  expect(migrated.priorities).toMatchObject({
    '01ARZ3NDEKTSV4RRFFQ6000021': 'P1',
    '01ARZ3NDEKTSV4RRFFQ6000022': 'P2',
    '01ARZ3NDEKTSV4RRFFQ6000023': 'P3',
    '01ARZ3NDEKTSV4RRFFQ6000024': 'P4',
    '01ARZ3NDEKTSV4RRFFQ6000025': 'P4',
  });
});

test('rename propagation at 10,000 tasks on REAL IndexedDB (S1 AC)', async ({ page }) => {
  await bootHarness(page);

  const dbName = `qa-e7-sweep-${String(Date.now())}`;
  const opened = await page.evaluate((name) => window.__e7.open(name), dbName);
  expect(opened.ok).toBe(true);

  const swept = await page.evaluate(() => window.__e7.seed10kAndSweep(10_000));
  // eslint-disable-next-line no-console
  console.log('[e7-e2e] sweep@10k:', JSON.stringify(swept));
  expect(swept.ok).toBe(true);
  expect(swept.written).toBe(10_000);
  expect(swept.allRenamed).toBe(true);
  expect(swept.sampleTag).toMatch(/^bucket-/u);
  // Budget: the impl recorded 31 ms on an in-memory substrate and claims the
  // sweep "fits the 2s budget". Real IndexedDB must at least stay interactive:
  // generous ceiling to catch a pathological regression, not to nitpick IDB speed.
  expect(swept.durationMs).toBeLessThan(2_000);
});
