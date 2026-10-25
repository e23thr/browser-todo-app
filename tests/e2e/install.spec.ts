/**
 * PWA installability E2E (ADR-008, S13 — the R1 structural fix).
 *
 * What real-device CI cannot prove (Android Chrome install, iOS Safari Add-to-Home-Screen and
 * the ITP exemption) is documented honestly in docs/dev/pwa-install.md; what CAN be proven
 * mechanically is proven here, against the real production pipeline (the fixture builds run
 * client build → precache → sw.js exactly like `npm run build`):
 *
 *   1. manifest `start_url`/`scope`/`id` agree with the ADR-005 Decision 8 service-worker
 *      scope under BOTH the GitHub Pages project-page base (`/<repo>/`) and the root base;
 *   2. the manifest, its link tag and every icon resolve under the configured base;
 *   3. prompt discipline: nothing before the first task of the session (acceptance criterion),
 *      the offer after it, and a dismissal that survives a reload (never nagging);
 *   4. post-install launch semantics: with `display-mode: standalone` (what the home-screen
 *      entry runs in), the offer never appears and the app boots normally;
 *   5. capture timing (E6-D1 regression): a `beforeinstallprompt` delivered BEFORE boot's
 *      awaits resolve is captured anyway (module-evaluation attach), and the offer still
 *      appears after the first task.
 *
 * The browser event is SYNTHESIZED: whether a headless build fires `beforeinstallprompt` is
 * browser-BUILD-dependent (the old "never fires headless" premise was wrong) — the repo's
 * bundled Playwright Chromium never fires it (n=0 over fresh profiles,
 * docs/qa/e6-install-logs/playwright-native-bip.mjs) while harness Chromium 145 fires it once
 * per load (7/7 loads at 19–178 ms after navigation, docs/qa/e6-install-logs/browser-probes.md).
 * A synthetic event keeps the suite deterministic across builds, and the DOM-level wiring under
 * test is exactly the production listener path.
 */

import { expect, test, type Page } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import { completeFirstRunOnboarding, startFixtureServer } from './sw-utils';

interface ManifestShape {
  readonly id: string;
  readonly start_url: string;
  readonly scope: string;
  readonly icons: readonly { readonly src: string }[];
}

let baseServer: StaticServer;
let rootServer: StaticServer;
let appUrl = '';
let rootUrl = '';

test.beforeAll(async () => {
  await ensureFixtures({ basePath: BASE_PATH });
  baseServer = await startFixtureServer(BASE_PATH);
  baseServer.setRoot(FIXTURES.vA);
  appUrl = `${baseServer.origin}${BASE_PATH}`;
  rootServer = await startFixtureServer('/');
  rootServer.setRoot(FIXTURES.rootA);
  rootUrl = `${rootServer.origin}/`;
});

test.afterAll(async () => {
  await baseServer.close();
  await rootServer.close();
});

async function readManifest(page: Page, url: string): Promise<ManifestShape> {
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ManifestShape;
}

/** Synthesize the Chromium install event (never guaranteed to fire headless — see above). */
async function dispatchInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __installPromptCalls?: number };
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => {
        target.__installPromptCalls = (target.__installPromptCalls ?? 0) + 1;
        return Promise.resolve();
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
}

/** The real capture flow (offline-data-journey contract a–b): list first, then capture on #/all. */
async function createTask(page: Page, title: string): Promise<void> {
  const newListButton = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newListButton.count()) > 0) {
    await newListButton.first().click();
    await page.getByLabel('List name', { exact: true }).fill('Install QA List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  await page.goto(`${appUrl}#/all`);
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await composer.waitFor({ state: 'attached', timeout: 15_000 });
  await composer.fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
}

test('manifest scope/start_url agree with the service-worker scope under the /<repo>/ base', async ({
  page,
}) => {
  await page.goto(appUrl);
  const manifest = await readManifest(page, `${appUrl}manifest.webmanifest`);

  // ADR-008 Decision 1: id/start_url/scope are the configured base — and the SW (ADR-005
  // Decision 8) registers at that same base.
  expect(manifest.start_url).toBe(BASE_PATH);
  expect(manifest.scope).toBe(BASE_PATH);
  expect(manifest.id).toBe(BASE_PATH);

  const linkHref = await page.evaluate(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    return link?.href ?? '';
  });
  expect(linkHref).toBe(`${new URL(appUrl).origin}${BASE_PATH}manifest.webmanifest`);

  const swScope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.scope ?? '';
  });
  expect(swScope).toBe(`${new URL(appUrl).origin}${BASE_PATH}`);

  // Self-hosted icons resolve under the base (zero third-party bytes, §7.2).
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
  for (const icon of manifest.icons) {
    expect(icon.src.startsWith(BASE_PATH)).toBe(true);
    const response = await page.request.get(`${new URL(appUrl).origin}${icon.src}`);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
  }
});

test('manifest and apple-touch icon also line up under the root base', async ({ page }) => {
  await page.goto(rootUrl);
  const manifest = await readManifest(page, `${rootUrl}manifest.webmanifest`);
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
  expect(manifest.id).toBe('/');

  const appleIcon = await page.request.get(
    `${new URL(rootUrl).origin}/icons/apple-touch-icon-180.png`,
  );
  expect(appleIcon.ok()).toBe(true);
});

test('install offer: nothing before the first task, offered after it, dismissal survives reload', async ({
  page,
}) => {
  await page.goto(appUrl);
  await completeFirstRunOnboarding(page);
  await dispatchInstallPrompt(page);

  // Acceptance criterion: the offer NEVER appears before the first task is created.
  await expect(page.locator('[data-install-notice]')).toHaveCount(0);

  await createTask(page, 'Install flow task');

  const notice = page.locator('[data-install-notice]');
  await expect(notice).toBeVisible();
  await expect(page.getByText('Keep your tasks — install Todo', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'No thanks', exact: true })).toBeVisible();

  // Dismiss once — remembered across sessions (ADR-008 Decision 3).
  await page.getByRole('button', { name: 'No thanks', exact: true }).click();
  await expect(page.locator('[data-install-notice]')).toHaveCount(0);

  await page.reload();
  await completeFirstRunOnboarding(page);
  await dispatchInstallPrompt(page);
  await createTask(page, 'Install flow second task');
  await expect(page.locator('[data-install-notice]')).toHaveCount(0);
});

test('install button hands the captured event to the browser', async ({ page }) => {
  await page.goto(appUrl);
  await completeFirstRunOnboarding(page);
  await dispatchInstallPrompt(page);
  await createTask(page, 'Install click task');

  await page.getByRole('button', { name: 'Install', exact: true }).click();
  const calls = await page.evaluate(
    () => (window as unknown as { __installPromptCalls?: number }).__installPromptCalls ?? 0,
  );
  expect(calls).toBe(1);
  await expect(page.locator('[data-install-notice]')).toHaveCount(0);
});

test('post-install launch (display-mode standalone): the app boots and never offers install', async ({
  page,
}) => {
  // What a home-screen launch runs in (ADR-008 Decision 3): emulated here via the exact media
  // query the app checks — a real device run is documented in docs/dev/pwa-install.md.
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => {
      if (query.includes('display-mode: standalone')) {
        return { matches: true, media: query } as unknown as MediaQueryList;
      }
      return original(query);
    };
  });

  await page.goto(appUrl);
  await completeFirstRunOnboarding(page);
  await dispatchInstallPrompt(page);
  await expect(
    page.getByRole('navigation', { name: 'Views and lists', exact: true }),
  ).toBeVisible();
  await createTask(page, 'Standalone task');
  await expect(page.locator('[data-install-notice]')).toHaveCount(0);
});

/**
 * E6-D1 regression: a `beforeinstallprompt` landing BEFORE boot reaches `bootInstallFlow()`
 * must still be captured. Real Chromium delivers the event at 19–178 ms after navigation —
 * before the boot awaits resolve (docs/qa/e6-install-logs/browser-probes.md) — and the old
 * boot-order attach lost it on every load (7/7).
 *
 * Timing discipline: the synthetic event is INSTALLED via `context.addInitScript` (before any
 * app script runs) and dispatched at `DOMContentLoaded` — spec-guaranteed to land AFTER the
 * entry module evaluated (module scripts block DOMContentLoaded, so the module-evaluation
 * capture listeners exist) and, as asserted below, BEFORE the boot-order attach point
 * (`#install-notice-root` mount — main.tsx `bootInstallFlow()`/`mountInstallNotice()`). An
 * event dispatched synchronously inside the init script would land before ANY page listener
 * could exist, which no in-page fix could ever capture.
 */
test('E6-D1: a pre-boot beforeinstallprompt is captured — offer appears after the first task', async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    const probe: { dispatchedAt?: number; mountedAt?: number; captured: boolean } = {
      captured: false,
    };
    (window as unknown as { __bipPreBoot: typeof probe }).__bipPreBoot = probe;

    // The boot-order attach point (mountInstallNotice) mounts in the same synchronous block as
    // the old listener attach — its mount time is the exact moment the old code attached.
    new MutationObserver(() => {
      if (
        probe.mountedAt === undefined &&
        document.getElementById('install-notice-root') !== null
      ) {
        probe.mountedAt = performance.now();
      }
    }).observe(document, { childList: true, subtree: true });

    window.addEventListener('DOMContentLoaded', () => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: () => Promise.resolve(),
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      });
      probe.dispatchedAt = performance.now();
      window.dispatchEvent(event);
      probe.captured = event.defaultPrevented;
    });
  });

  await page.goto(appUrl);
  await completeFirstRunOnboarding(page);

  // The event landed pre-boot: captured at dispatch time (the module-evaluation listener ran)
  // and strictly before the boot-order attach point mounted.
  const probe = await page.evaluate(
    () =>
      (
        window as unknown as {
          __bipPreBoot: { dispatchedAt?: number; mountedAt?: number; captured: boolean };
        }
      ).__bipPreBoot,
  );
  const { captured, dispatchedAt, mountedAt } = probe;
  expect(captured).toBe(true);
  expect(dispatchedAt).toBeDefined();
  expect(mountedAt).toBeDefined();
  if (dispatchedAt === undefined || mountedAt === undefined) {
    throw new Error('pre-boot probe missing dispatch/mount timings');
  }
  expect(dispatchedAt).toBeLessThan(mountedAt);

  // Acceptance: the captured pre-boot event still yields the offer after the first task.
  await createTask(page, 'Pre-boot install task');
  await expect(page.locator('[data-install-notice]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
});
