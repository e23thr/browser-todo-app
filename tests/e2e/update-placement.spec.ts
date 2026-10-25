/**
 * Update-notice placement regression (design spec ux-foundation.md §6.10 "above tab bar/FAB" +
 * WCAG 2.2 SC 2.4.11 Focus Not Obscured – Minimum, AA).
 *
 * Follow-up to the E6 installability review (t_6e9e4f81 §4.4): `.update-notice-stack` shipped
 * with the install notice's exact placement — fixed, right/bottom `var(--space-4)`,
 * `z-index: 100` — and because `.tabbar`/`.fab` are also z-index 100 but earlier in the DOM,
 * a shown update toast painted OVER them at compact widths: it entirely covered the FAB
 * (keyboard focus could sit on a 100%-hidden control → 2.4.11) and all but a 16 px strip of
 * the 56 px bottom tab bar (§6.10 violation).
 *
 * The probe style follows docs/qa/install-review-occlusion.spec.ts (the review probe that
 * proved the sibling install-notice defect), inverted: while the real update toast is up, the
 * notice rects must NOT intersect `.fab`/`.tabbar`, and a focused FAB's centre + four inset
 * corners must NOT resolve inside `.update-notice`.
 */

import { expect, test, type Page } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH, seedOnboardingDone } from './helpers';
import {
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

    const stack = document.querySelector('.update-notice-stack');
    const fab = document.querySelector<HTMLElement>('.fab');
    const tabbar = document.querySelector('.tabbar');
    const notices = [...document.querySelectorAll('.update-notice')];
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
        insideNotice: hit?.closest('.update-notice') != null,
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
        insideNotice: tabElement?.closest('.update-notice') != null,
      },
      rects: {
        stack: round(stackRect),
        fab: round(fabRect),
        tabbar: round(tabRect),
      },
    };
  });
}

test('update notice clears the FAB and tab bar at compact widths (§6.10, WCAG 2.2 2.4.11)', async ({
  page,
}) => {
  // Both test viewports are below the §3.6 1024 px split: the shell renders .tabbar + .fab.
  await page.setViewportSize({ width: 360, height: 740 });
  await seedOnboardingDone(page);
  await page.goto(appUrl);
  await waitForControlled(page);
  await expect(page.locator('.fab')).toBeVisible();
  await expect(page.locator('.tabbar')).toBeVisible();

  // The REAL update toast (ADR-005 Decision 9 fixtures): deploy build B and drive the
  // update check to the waiting state — the placement under test is the one users see.
  server.setRoot(FIXTURES.vB);
  await triggerUpdateCheck(page);
  await expect(page.getByText('Update available', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(updateNotice(page)).toBeVisible();

  for (const viewport of [
    { width: 360, height: 740 },
    { width: 768, height: 900 },
  ]) {
    const label = `${String(viewport.width)}×${String(viewport.height)}`;
    await page.setViewportSize(viewport);
    await expect(page.locator('.fab')).toBeVisible();
    await expect(updateNotice(page)).toBeVisible();

    const report = await probePlacement(page);
    // eslint-disable-next-line no-console -- logged evidence for the placement failure mode
    console.log(`PLACEMENT_PROBE ${label}:`, JSON.stringify(report));

    expect(report.activeIsFab, `${label}: FAB must be focusable while the toast is shown`).toBe(
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
      `${label}: no FAB probe point may resolve inside .update-notice (got ${JSON.stringify(
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
