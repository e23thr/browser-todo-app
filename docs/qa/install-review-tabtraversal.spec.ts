/** TEMPORARY review probe (h_reviewer t_6e9e4f81): REAL keyboard Tab traversal — does focus
 *  land on the FAB while it is entirely hidden behind the install notice (WCAG 2.2 SC 2.4.11)? */
import { expect, test } from '@playwright/test';

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

test('real Tab traversal: FAB focus state while the install notice is up', async ({ page }) => {
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
  // Same order as install.spec's createTask: navigate first, then the list gate.
  await page.goto(`${appUrl}#/all`);
  const newList = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newList.count()) > 0) {
    await newList.first().click();
    await page.getByLabel('List name', { exact: true }).fill('Tab List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
  }
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await composer.waitFor({ state: 'attached', timeout: 15_000 });
  await composer.fill('Tab traversal task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Tab traversal task' })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.locator('[data-install-notice]')).toBeVisible();

  // Start sequential focus navigation from the document and walk it.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
  });

  const traversal: string[] = [];
  let fabSeen: { hiddenBehindNotice: boolean } | null = null;
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab');
    const step = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { tag: 'NONE', text: '', fab: false, occluded: false };
      const isFab = el.classList.contains('fab');
      let occluded = false;
      if (isFab) {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        occluded = hit?.closest('.install-notice') != null;
      }
      return {
        tag: el.tagName,
        cls: el.className,
        text: (el.textContent ?? '').trim().slice(0, 24),
        fab: isFab,
        occluded,
      };
    });
    traversal.push(
      `${step.tag}${step.cls ? '.' + step.cls : ''}${step.text ? `("${step.text}")` : ''}${
        step.occluded ? ' [HIDDEN-BEHIND-NOTICE]' : ''
      }`,
    );
    if (step.fab) fabSeen = { hiddenBehindNotice: step.occluded };
    if (step.text === 'Install' || step.text === 'No thanks') break;
  }
  console.log('TRAVERSAL:', JSON.stringify(traversal, null, 1));
  console.log('FAB_IN_TAB_ORDER:', JSON.stringify(fabSeen));

  // Also confirm the notice itself does not auto-focus on appearance.
  await page.reload();
  await completeFirstRunOnboarding(page);
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(event);
  });
});
