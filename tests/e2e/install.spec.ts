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
 *      entry runs in), the offer never appears and the app boots normally.
 *
 * The browser event is SYNTHESIZED (`beforeinstallprompt` is Chromium-only and never fires
 * headless), so the DOM-level wiring under test is exactly the production listener path.
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

/** Synthesize the Chromium install event (headless browsers never fire it themselves). */
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
