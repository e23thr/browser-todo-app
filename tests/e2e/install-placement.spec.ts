/**
 * Install-notice placement regression (design spec ux-foundation.md §6.10 "above tab bar/FAB" +
 * WCAG 2.2 SC 2.4.11 Focus Not Obscured – Minimum, AA; M13 release gate).
 *
 * Rework for the E6 installability review round 1 (t_6e9e4f81 §3/B1): `.install-notice-stack`
 * shipped fixed, right/bottom `var(--space-4)`, `z-index: 100` — because `.tabbar`/`.fab` are
 * also z-index 100 but earlier in the DOM, a shown install notice painted OVER them at compact
 * widths: it entirely covered the FAB (real keyboard Tab traversal landed focus on a
 * 100%-hidden BUTTON.fab → textbook 2.4.11) and 40 of the tab bar's 56 px (§6.10 violation).
 *
 * The probe style follows docs/qa/install-review-occlusion.spec.ts (the review probe that
 * PROVED the failure), inverted: while the real install notice is up, the notice rects must
 * NOT intersect `.fab`/`.tabbar`, and a focused FAB's centre + four inset corners must NOT
 * resolve inside `.install-notice`. Mirrors tests/e2e/update-placement.spec.ts (the update
 * toast's twin fix, t_8f6a2009) so both surfaces stay pinned by the same geometry.
 */

import { expect, test, type Page } from '@playwright/test';

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

/** Synthesize the Chromium install event (headless never fires the real one). */
async function dispatchInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
}

/**
 * The real capture flow (install.spec.ts contract): list first on the landing page, then the
 * composer on #/all — the offer appears after the first task of the session.
 */
async function createTask(page: Page, title: string): Promise<void> {
  const newListButton = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newListButton.count()) > 0) {
    await newListButton.first().click();
    await page.getByLabel('List name', { exact: true }).fill('Install Placement List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  await page.goto(`${appUrl}#/all`);
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await composer.waitFor({ state: 'attached', timeout: 15_000 });
  await composer.fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
}

function installNotice(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-install-notice]');
}

/**
 * Boot the app and surface the REAL install notice. Task creation runs at Playwright's default
 * desktop viewport: the composer renders inline only there (at compact widths it sits behind
 * an "Add task" button), which is exactly what install.spec.ts's createTask relies on. The
 * probes then resize to the compact/wide viewports — the offer is once-per-session and stays
 * on screen across a resize, so the placement under test is still the one users see.
 */
async function showInstallNotice(page: Page, title: string): Promise<void> {
  await page.goto(appUrl);
  await waitForControlled(page);
  await completeFirstRunOnboarding(page);
  await dispatchInstallPrompt(page);
  await createTask(page, title);
  await expect(installNotice(page)).toBeVisible({ timeout: 15_000 });
}

interface PlacementReport {
  activeIsFab: boolean;
  stackVsFab: boolean;
  stackVsTabbar: boolean;
  noticeVsFab: boolean[];
  noticeVsTabbar: boolean[];
  /** elementFromPoint over the focused FAB: centre first, then four inset corners. */
  fabHits: { tag: string; insideNotice: boolean; insideFab: boolean }[];
  tabHit: { tag: string; insideNotice: boolean };
  rects: Record<string, { left: number; top: number; right: number; bottom: number }>;
}

async function probePlacement(page: Page): Promise<PlacementReport> {
  return page.evaluate(() => {
    const intersects = (a: DOMRect, b: DOMRect): boolean =>
      Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
      Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
    const round = (r: DOMRect): { left: number; top: number; right: number; bottom: number } => ({
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
    });

    const stack = document.querySelector('.install-notice-stack');
    const fab = document.querySelector<HTMLElement>('.fab');
    const tabbar = document.querySelector('.tabbar');
    const notices = [...document.querySelectorAll('.install-notice')];
    if (stack === null || fab === null || tabbar === null || notices.length === 0) {
      throw new Error(
        `probe preconditions missing: stack=${String(stack !== null)} fab=${String(
          fab !== null,
        )} tabbar=${String(tabbar !== null)} notices=${String(notices.length)}`,
      );
    }

    const stackRect = stack.getBoundingClientRect();
    const fabRect = fab.getBoundingClientRect();
    const tabRect = tabbar.getBoundingClientRect();

    // 2.4.11 hit probe: focus the FAB (as a Tab stop would), then ask the browser what is
    // ACTUALLY painted at its centre and four inset corners while it holds focus.
    fab.focus();
    const points: [number, number][] = [
      [fabRect.left + fabRect.width / 2, fabRect.top + fabRect.height / 2],
      [fabRect.left + 2, fabRect.top + 2],
      [fabRect.right - 2, fabRect.top + 2],
      [fabRect.left + 2, fabRect.bottom - 2],
      [fabRect.right - 2, fabRect.bottom - 2],
    ];
    const fabHits = points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return {
        tag: hit === null ? 'null' : hit.tagName,
        insideNotice: hit?.closest('.install-notice') != null,
        insideFab: hit?.closest('.fab') != null,
      };
    });

    const firstTab = document.querySelector('.tabbar .tab');
    if (firstTab === null) throw new Error('probe preconditions missing: no .tabbar .tab');
    const firstTabRect = firstTab.getBoundingClientRect();
    const tabElement = document.elementFromPoint(
      firstTabRect.left + firstTabRect.width / 2,
      firstTabRect.top + firstTabRect.height / 2,
    );

    return {
      activeIsFab: document.activeElement === fab,
      stackVsFab: intersects(stackRect, fabRect),
      stackVsTabbar: intersects(stackRect, tabRect),
      noticeVsFab: notices.map((n) => intersects(n.getBoundingClientRect(), fabRect)),
      noticeVsTabbar: notices.map((n) => intersects(n.getBoundingClientRect(), tabRect)),
      fabHits,
      tabHit: {
        tag: tabElement === null ? 'null' : tabElement.tagName,
        insideNotice: tabElement?.closest('.install-notice') != null,
      },
      rects: {
        stack: round(stackRect),
        fab: round(fabRect),
        tabbar: round(tabRect),
      },
    };
  });
}

test('install notice clears the FAB and tab bar at compact widths (§6.10, WCAG 2.2 2.4.11)', async ({
  page,
}) => {
  // Setup runs at the default desktop viewport (inline composer); the probes below then move
  // to both viewports under the §3.6 1024 px split, where the shell renders .tabbar + .fab.
  await showInstallNotice(page, 'Placement task');

  for (const viewport of [
    { width: 360, height: 740 },
    { width: 768, height: 900 },
  ]) {
    const label = `${String(viewport.width)}×${String(viewport.height)}`;
    await page.setViewportSize(viewport);
    await expect(page.locator('.fab')).toBeVisible();
    await expect(page.locator('.tabbar')).toBeVisible();
    await expect(installNotice(page)).toBeVisible();

    const report = await probePlacement(page);
    // eslint-disable-next-line no-console -- logged evidence for the placement failure mode
    console.log(`INSTALL_PLACEMENT_PROBE ${label}:`, JSON.stringify(report));

    expect(report.activeIsFab, `${label}: FAB must be focusable while the notice is shown`).toBe(
      true,
    );
    expect(report.stackVsFab, `${label}: notice stack must not intersect the FAB`).toBe(false);
    expect(report.stackVsTabbar, `${label}: notice stack must not intersect the tab bar`).toBe(
      false,
    );
    expect(
      report.noticeVsFab.every((hits) => !hits),
      `${label}: every notice card must clear the FAB (got ${JSON.stringify(report.noticeVsFab)})`,
    ).toBe(true);
    expect(
      report.noticeVsTabbar.every((hits) => !hits),
      `${label}: every notice card must clear the tab bar (got ${JSON.stringify(
        report.noticeVsTabbar,
      )})`,
    ).toBe(true);

    // 2.4.11: with the FAB focused, its centre must hit the FAB itself and NO probe point may
    // resolve inside the notice — "entirely hidden" is the SC threshold; this proves zero
    // coverage rather than partial.
    expect(report.fabHits[0]?.insideFab, `${label}: focused FAB centre must hit the FAB`).toBe(
      true,
    );
    expect(
      report.fabHits.every((hit) => !hit.insideNotice),
      `${label}: no FAB probe point may resolve inside .install-notice (got ${JSON.stringify(
        report.fabHits,
      )})`,
    ).toBe(true);

    // §6.10: the tab bar stays pointer-usable — its centre is not covered by the notice.
    expect(
      report.tabHit.insideNotice,
      `${label}: tab centre hit ${report.tabHit.tag} insideNotice=${String(
        report.tabHit.insideNotice,
      )}`,
    ).toBe(false);
  }
});

test('at the §3.6 wide split the notice returns to a plain corner inset (no tab bar/FAB)', async ({
  page,
}) => {
  await showInstallNotice(page, 'Wide placement task');

  await page.setViewportSize({ width: 1280, height: 800 });
  // Above 1024 px the shell drops .tabbar/.fab entirely — nothing to clear.
  await expect(page.locator('.fab')).toHaveCount(0);
  await expect(page.locator('.tabbar')).toHaveCount(0);
  await expect(installNotice(page)).toBeVisible();

  // The wide media query pins bottom back to the plain space-4 corner inset.
  const bottom = await page
    .locator('.install-notice-stack')
    .evaluate((el) => getComputedStyle(el).bottom);
  expect(bottom, 'wide: stack bottom should be the plain --space-4 inset').toBe('16px');
});
