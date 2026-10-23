/**
 * Service-worker E2E helpers (ADR-005 Decision 9).
 *
 * Per-context discipline from the ADR: `serviceWorkers: 'allow'` (never `'block'`), and every
 * offline test waits for `navigator.serviceWorker.ready` AND a claimed `controller` BEFORE
 * `context.setOffline(true)` — otherwise first-load caching races make the suite flaky.
 */

import { expect, type Frame, type Page } from '@playwright/test';

import { createStaticServer, type StaticServer } from './fixtures/static-server.mjs';

/**
 * Boot budget assertion for warm/offline start-to-interactive (§9.1). The `e2e-full` job in
 * .github/workflows/nightly.yml sets `E2E_BOOT_BUDGET_MS: '300'` in its job env to hold the real
 * line (ADR-005 Decision 9, test 2); any run without that variable — the PR gate's `e2e:sw` job
 * in ci.yml and local runs — falls back to the loose 1500 ms flake guard below.
 */
export const BOOT_BUDGET_MS = Number(process.env['E2E_BOOT_BUDGET_MS'] ?? '1500');

const PORT_RANGE_START = 4183;

/** Start a fixture server on the first free port in a small range (per-file, parallel-safe). */
export async function startFixtureServer(mountPath: string): Promise<StaticServer> {
  for (let offset = 0; offset < 20; offset += 1) {
    const server = createStaticServer({ mountPath, port: PORT_RANGE_START + offset });
    try {
      await server.listen();
      return server;
    } catch {
      // port busy — try the next one
    }
  }
  throw new Error(
    `no free fixture-server port in ${String(PORT_RANGE_START)}..${String(PORT_RANGE_START + 19)}`,
  );
}

/** Wait for `navigator.serviceWorker.ready` AND a claimed controller (ADR-005 Decision 9). */
export async function waitForControlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 20_000,
  });
}

/** CacheStorage names visible to the page. */
export async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => caches.keys());
}

/** Entry URLs of one cache (absolute). */
export async function cacheEntryUrls(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => request.url);
  }, cacheName);
}

/**
 * Trigger the app's update check (`registration.update()`), swallowing the rejection — a failed
 * check is SILENT by design (Decision 6) and must produce no page-level error.
 */
export async function triggerUpdateCheck(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    try {
      await registration?.update();
    } catch {
      // silent (ADR-005 Decision 6)
    }
  });
}

/** Start-to-interactive in ms since navigation start (the `app:interactive` mark). */
export async function interactiveStartMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const [mark] = performance.getEntriesByName('app:interactive');
    return mark === undefined ? -1 : mark.startTime;
  });
}

/** Count main-frame navigations from now on (a reload is a main-frame navigation). */
export function countMainNavigations(page: Page): () => number {
  let count = 0;
  const listener = (frame: Frame): void => {
    if (frame === page.mainFrame()) count += 1;
  };
  page.on('framenavigated', listener);
  return () => count;
}

/** Install the CSP-violation collector used by the parity checks (ADR-005 Decision 9, test 9). */
export async function installCspCollector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.violatedDirective} blocked=${event.blockedURI}`);
    });
  });
}

/** Read the collected CSP violations. */
export async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
}

/** The update notice root exists only while a notice is on screen. */
export function updateNotice(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-update-notice]');
}

/** Assert the page did not reload since a window marker was planted (E9 evidence). */
export async function plantNoReloadMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __noReloadMarker: number }).__noReloadMarker = 1;
  });
}

export async function noReloadMarkerPresent(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __noReloadMarker?: number }).__noReloadMarker === 1,
  );
}

/** Assert exactly one cache exists and it matches the versioned shell naming. */
export async function expectSingleVersionedCache(page: Page): Promise<string> {
  const names = await cacheNames(page);
  expect(names).toHaveLength(1);
  const name = names[0] ?? '';
  expect(name).toMatch(/^todo-shell:.+:v:[0-9a-f]{16}$/u);
  return name;
}
