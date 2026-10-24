/**
 * E3 data-safety UX — REAL StorageManager pass (test card t_b1595f03, epic E3).
 *
 * The jsdom suite (`tests/component/data-safety-ux-qa.test.tsx`) scripts every storage
 * state; this spec is the other half of the card goal: the same surface running in a REAL
 * Chromium page where `navigator.storage` is a real StorageManager and IndexedDB is real.
 * What only a real browser can prove:
 *   - the quota meter quotes the browser's OWN estimate() numbers (no mock drift),
 *   - the persistence row tells the truth about the real persisted()/persist() answer,
 *   - persist() is requested exactly once at the first meaningful write, against the
 *     real permission API,
 *   - the §5.6 dialog keyboard contract holds with REAL key events (Tab trap both ways,
 *     Escape = safe close, focus return to the opener),
 *   - the backup nudge follows the REAL clock (>14 days fires, below threshold is quiet).
 *
 * Locator policy (D1 guard): every getByRole(..., { name }) and getByText(...) carries
 * `exact: true` — see eslint.config.js and docs/qa/e1-scaffold-gates.md §2.7.
 *
 * The harness (`tests/e2e/data-safety-ux/harness.tsx`) mounts the production Preact
 * surface over the production engine; bundled per-config into the gitignored fixtures dir
 * (never the shared `dist/`), served by the ADR-005 fixture server.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import type { StaticServer } from './fixtures/static-server.mjs';
import { startFixtureServer } from './sw-utils';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS_CONFIG = 'tests/e2e/data-safety-ux/vite.config.mjs';
/** Per-worker output dir: parallel workers must never build the same directory concurrently. */
const OUT_DIR = resolve(
  REPO_ROOT,
  'tests',
  'e2e',
  '.fixtures',
  `data-safety-ux-${String(process.pid)}`,
);

interface QaApi {
  readonly ready: boolean;
  persistCalls(): number;
  verdict(): 'confirmed' | 'cancelled' | null;
  setBackupAge(days: number | null): void;
  noteFirstWrite(): Promise<unknown>;
  requestPersist(): Promise<string>;
  openQuotaDialog(pendingCount: number): void;
}

declare global {
  var __qa: QaApi | undefined;
}

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

/** Boot the real surface and wait for the harness seam. */
async function boot(page: Page): Promise<void> {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => globalThis.__qa?.ready === true);
}

test('the quota meter quotes the browser OWN estimate() numbers (no mock drift)', async ({
  page,
}) => {
  await boot(page);

  // The browser's own view of its storage…
  const estimate = await page.evaluate(() => navigator.storage.estimate());
  expect(estimate.quota ?? 0).toBeGreaterThan(0);
  const usage = estimate.usage ?? 0;
  const quota = estimate.quota as number;

  // …must be what the panel renders (percentOf = Math.round, ±1 for usage drift
  // between the panel's refresh and this probe).
  const meter = page.getByRole('meter');
  await expect(meter).toBeVisible();
  const shown = Number(await meter.getAttribute('aria-valuenow'));
  const expected = Math.round((usage / quota) * 100);
  expect(Math.abs(shown - expected)).toBeLessThanOrEqual(1);

  // Internal consistency: the visible value line carries the same percentage.
  await expect(page.getByText(new RegExp(`${String(shown)}%`, 'u'), { exact: true })).toBeVisible();
});

test('the persistence row tells the truth about the REAL persisted() state', async ({ page }) => {
  await boot(page);

  const persisted = await page.evaluate(() => navigator.storage.persisted());
  if (persisted) {
    await expect(
      page.getByText('Protected — this browser is keeping app data', { exact: true }),
    ).toBeVisible();
  } else {
    // Never requested in this profile → the honest "not requested" affordance, never a
    // false "Protected".
    await expect(
      page.getByText('Not protected — this browser may clear app data', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Request protection', exact: true }),
    ).toBeVisible();
  }
});

test('persist() is requested exactly once at the first meaningful write (real API)', async ({
  page,
}) => {
  await boot(page);
  expect(await page.evaluate(() => globalThis.__qa?.persistCalls())).toBe(0);

  // First successful write → the gate fires exactly one REAL persist() round trip.
  await page.evaluate(() => globalThis.__qa?.noteFirstWrite());
  await page.waitForFunction(() => (globalThis.__qa?.persistCalls() ?? 0) >= 1);
  expect(await page.evaluate(() => globalThis.__qa?.persistCalls())).toBe(1);

  // A second meaningful write must not re-request (once-only per profile).
  await page.evaluate(() => globalThis.__qa?.noteFirstWrite());
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => globalThis.__qa?.persistCalls())).toBe(1);

  // The row now reflects the browser's REAL answer — granted or denied, never a guess.
  // On denial, BOTH the T2 banner and the persistence row offer "Ask again" (§6.5/§4.3),
  // so scope the query to the "Keeping your data" region.
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  const row = page.getByRole('region', { name: 'Keeping your data', exact: true });
  if (persisted) {
    await expect(
      row.getByText('Protected — this browser is keeping app data', { exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      row.getByText('Not protected — this browser may clear app data', { exact: true }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Ask again', exact: true })).toBeVisible();
  }
});

test('REAL keyboard: Tab traps in the quota dialog, Escape takes the safe path, focus returns', async ({
  page,
}) => {
  await boot(page);

  // A real opener inside the panel (focus return target). The hidden file picker
  // (`<input type="file" aria-label="Import…">`) also resolves to the `button` role, so scope to
  // the real, focusable <button> — the picker is tabIndex -1 and never a focus target.
  const opener = page
    .getByRole('button', { name: 'Import…', exact: true })
    .and(page.locator('button'));
  await opener.focus();

  await page.evaluate(() => globalThis.__qa?.openQuotaDialog(2));
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  // Real autofocus landed on the safest action (never the destructive confirm).
  const freeSpace = page.getByRole('button', { name: 'Free up space', exact: true });
  await expect(freeSpace).toBeFocused();

  // Tab cycles inside the dialog and WRAPS at the end — the real focus never escapes.
  const exportButton = page.getByRole('button', { name: 'Export a backup', exact: true });
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  await page.keyboard.press('Tab');
  await expect(exportButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();
  await page.keyboard.press('Tab'); // wrap: last → first
  await expect(freeSpace).toBeFocused();
  await page.keyboard.press('Shift+Tab'); // wrap back: first → last
  await expect(retry).toBeFocused();

  // Escape = close WITHOUT taking any action, and focus returns to the opener.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => globalThis.__qa?.verdict())).toBe('cancelled');
  await expect(opener).toBeFocused();
});

test('the backup nudge follows the REAL clock: fires beyond 14 days, quiet below', async ({
  page,
}) => {
  await boot(page);

  // Below the threshold: quiet (whatever the day-of-week).
  await page.evaluate(() => globalThis.__qa?.setBackupAge(13));
  await expect(page.getByText(/since your last backup\./u, { exact: true })).toHaveCount(0);

  // At/after the threshold: fires, and the day count is the REAL calendar difference
  // (relativeAge counts calendar days, not 24h blocks).
  await page.evaluate(() => globalThis.__qa?.setBackupAge(20));
  const calendarDays = await page.evaluate(() => {
    const startOfDay = (ms: number): number => {
      const date = new Date(ms);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    };
    const at = Date.now() - 20 * 86_400_000;
    return Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86_400_000);
  });
  await expect(
    page.getByText(
      new RegExp(`It's been ${String(calendarDays)} days since your last backup\\.`, 'u'),
      {
        exact: true,
      },
    ),
  ).toBeVisible();

  // A fresh backup clears it (§6.3).
  await page.evaluate(() => globalThis.__qa?.setBackupAge(0));
  await expect(page.getByText(/since your last backup\./u, { exact: true })).toHaveCount(0);
});
