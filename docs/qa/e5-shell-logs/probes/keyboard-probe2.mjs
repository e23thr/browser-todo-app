/**
 * QA probe part 2 (h_reviewer, t_46150118) — drawer dialog semantics + focus management.
 * Fresh context per step (lesson from probe 1: same-URL page.goto is a no-op navigation).
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const out = [];
const log = (step, data) => {
  out.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};

const activeInfo = () => {
  const el = document.activeElement;
  return {
    tag: el.tagName.toLowerCase(),
    cls: typeof el.className === 'string' ? el.className : '',
    text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
    inDrawer: !!el.closest('.drawer'),
    tabindex: el.getAttribute('tabindex'),
  };
};

const browser = await chromium.launch();

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
  await page.waitForSelector('.shell');
  return { context, page };
}

// --- Drawer via the app bar menu button ---
{
  const { context, page } = await freshPage();
  await page.click('.appbar button');
  await page.waitForTimeout(300);
  log('drawer opened (menu button)', await page.evaluate(() => {
    const d = document.querySelector('.drawer');
    return {
      role: d?.getAttribute('role'),
      ariaModal: d?.getAttribute('aria-modal'),
      ariaLabel: d?.getAttribute('aria-label'),
      backgroundHidden: document.querySelector('.shell-body').getAttribute('aria-hidden'),
      scrimPresent: !!document.querySelector('.drawer-scrim'),
      active: (() => {
        const el = document.activeElement;
        return { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', inDrawer: !!el.closest('.drawer') };
      })(),
    };
  }));

  const trap = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    trap.push(await page.evaluate(() => !!document.activeElement.closest('.drawer')));
  }
  log('focus trap: 14 tabs', { allInsideDrawer: trap.every(Boolean), escapedAt: trap.indexOf(false) });

  // Shift-Tab wrap as well
  const trapBack = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    trapBack.push(await page.evaluate(() => !!document.activeElement.closest('.drawer')));
  }
  log('focus trap: 6 shift-tabs', { allInsideDrawer: trapBack.every(Boolean), escapedAt: trapBack.indexOf(false) });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  log('after Esc (menu opener)', await page.evaluate(() => ({
    drawerPresent: !!document.querySelector('.drawer'),
    backgroundHidden: document.querySelector('.shell-body').getAttribute('aria-hidden'),
    active: (() => {
      const el = document.activeElement;
      return { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) };
    })(),
  })));
  await context.close();
}

// --- Drawer via the "More" tab button ---
{
  const { context, page } = await freshPage();
  await page.click('button.tab:has-text("More")');
  await page.waitForTimeout(300);
  const openedActive = await page.evaluate(activeInfo);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  log('drawer via More tab; after Esc', { openedActive, closed: await page.evaluate(() => ({
    drawerPresent: !!document.querySelector('.drawer'),
    active: (() => {
      const el = document.activeElement;
      return { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) };
    })(),
  }))});
  await context.close();
}

// --- Scrim click closes the drawer (visible scrim area needs a wider viewport;
//     at 320px the drawer's max-width 320px covers the whole width by design) ---
{
  const context = await browser.newContext({ viewport: { width: 400, height: 568 } });
  const page = await context.newPage();
  await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
  await page.waitForSelector('.shell');
  await page.click('.appbar button');
  await page.waitForTimeout(250);
  await page.click('.drawer-scrim', { position: { x: 370, y: 300 } });
  await page.waitForTimeout(300);
  log('scrim click at 400px width', { drawerPresent: await page.evaluate(() => !!document.querySelector('.drawer')) });
  await context.close();
}

// --- SPA route change: focus to h1 + polite announcement + aria-current ---
{
  const { context, page } = await freshPage();
  await page.click('a.tab:has-text("All open")');
  await page.waitForTimeout(400);
  log('route change -> #/all (tab bar)', await page.evaluate(() => {
    const el = document.activeElement;
    return {
      active: { tag: el.tagName.toLowerCase(), tabindex: el.getAttribute('tabindex'), text: (el.textContent || '').trim().slice(0, 40) },
      polite: (document.querySelector('[role="status"]') || {}).textContent,
      assertive: (document.querySelector('[role="alert"]') || {}).textContent,
      ariaCurrent: [...document.querySelectorAll('[aria-current="page"]')].map((n) => (n.textContent || '').trim().slice(0, 20)),
      hash: location.hash,
    };
  }));

  // Lazy route via drawer link: drawer must close and focus must land on the view h1.
  await page.click('.appbar button');
  await page.waitForTimeout(250);
  await page.click('.drawer a[href="#/settings"]');
  await page.waitForTimeout(600);
  log('route change -> #/settings (drawer link, lazy chunk)', await page.evaluate(() => {
    const el = document.activeElement;
    return {
      active: { tag: el.tagName.toLowerCase(), tabindex: el.getAttribute('tabindex'), text: (el.textContent || '').trim().slice(0, 40) },
      drawerPresent: !!document.querySelector('.drawer'),
      polite: (document.querySelector('[role="status"]') || {}).textContent,
      hash: location.hash,
    };
  }));
  await context.close();
}

await browser.close();
writeFileSync(new URL('./keyboard-probe2-results.json', import.meta.url), JSON.stringify(out, null, 2));
