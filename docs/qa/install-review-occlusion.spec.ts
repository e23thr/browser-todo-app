/** TEMPORARY review probe (h_reviewer t_6e9e4f81): WCAG 2.2 SC 2.4.11 check — while the
 *  install notice is shown at a compact viewport, is a keyboard-focused component (FAB)
 *  ENTIRELY hidden behind the author-created notice card? */
import { expect, test, type Page } from '@playwright/test';

import { FIXTURES, ensureFixtures } from './fixtures/build-fixtures.mjs';
import type { StaticServer } from './fixtures/static-server.mjs';
import { BASE_PATH } from './helpers';
import { completeFirstRunOnboarding, startFixtureServer } from './sw-utils';

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

async function createTask(page: Page, title: string): Promise<void> {
  await page.goto(`${appUrl}#/all`);
  const newListButton = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newListButton.count()) > 0) {
    await newListButton.first().click();
    await page.getByLabel('List name', { exact: true }).fill('Occlusion List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await composer.waitFor({ state: 'attached', timeout: 15_000 });
  await composer.fill(title);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
}

test('2.4.11 probe: focused FAB / tab items vs the install notice at 360px', async ({ page }) => {
  await page.goto(appUrl);
  await completeFirstRunOnboarding(page);
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
  await createTask(page, 'Occlusion task');
  await page.setViewportSize({ width: 360, height: 740 });

  const notice = page.locator('[data-install-notice]');
  await expect(notice).toBeVisible();

  // 1. FAB: focus it, then ask the browser what is actually painted at its center.
  const fabReport = await page.evaluate(() => {
    const fab = document.querySelector('.fab') as HTMLElement | null;
    if (!fab) return { found: false };
    fab.focus();
    const r = fab.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const insideNotice = hit?.closest('.install-notice') != null;
    const style = getComputedStyle(fab);
    return {
      found: true,
      activeIsFab: document.activeElement === fab,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      hitTag: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : 'null',
      entirelyOccluded: insideNotice,
      display: style.display,
      visibility: style.visibility,
      // Also probe the 4 corners — "entirely hidden" means EVERY point covered.
      cornersOccluded: (
        [
          [r.left + 2, r.top + 2],
          [r.right - 2, r.top + 2],
          [r.left + 2, r.bottom - 2],
          [r.right - 2, r.bottom - 2],
        ] as const
      ).map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('.install-notice') != null;
      }),
    };
  });
  console.log('FAB_FOCUS_PROBE:', JSON.stringify(fabReport));

  // 2. Tab bar: focus the first tab link/button, same occlusion test.
  const tabReport = await page.evaluate(() => {
    const tab = document.querySelector('.tabbar button, .tabbar a') as HTMLElement | null;
    if (!tab) return { found: false };
    tab.focus();
    const r = tab.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      found: true,
      activeIsTab: document.activeElement === tab,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      hitTag: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : 'null',
      centerOccludedByNotice: hit?.closest('.install-notice') != null,
      // How much of the target's height is NOT covered by the notice?
      exposedHeight: (() => {
        const noticeEl = document.querySelector('.install-notice');
        if (!noticeEl) return r.height;
        const nr = noticeEl.getBoundingClientRect();
        const coveredTop = Math.max(0, Math.min(r.bottom, nr.bottom) - Math.max(r.top, nr.top));
        return r.height - coveredTop;
      })(),
    };
  });
  console.log('TAB_FOCUS_PROBE:', JSON.stringify(tabReport));

  // 3. Does anything in the shell move the notice above the tab bar at another breakpoint?
  await page.setViewportSize({ width: 768, height: 900 });
  const at768 = await page.evaluate(() => {
    const noticeEl = document.querySelector('.install-notice');
    const tab = document.querySelector('.tabbar');
    const fab = document.querySelector('.fab');
    const nr = noticeEl?.getBoundingClientRect();
    const overlap = (el: Element | null) => {
      if (!el || !nr) return null;
      const r = el.getBoundingClientRect();
      const oy = Math.min(nr.bottom, r.bottom) - Math.max(nr.top, r.top);
      const ox = Math.min(nr.right, r.right) - Math.max(nr.left, r.left);
      return ox > 0 && oy > 0 ? { ox, oy } : 'clear';
    };
    return { noticeBottom: nr?.bottom, tab: overlap(tab), fab: overlap(fab) };
  });
  console.log('AT_768:', JSON.stringify(at768));
});
