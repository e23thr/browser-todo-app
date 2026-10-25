/**
 * QA probe (h_reviewer, t_46150118) — keyboard navigation, focus management, structure.
 *
 * Checks (design §4.1 / §6.9 / §11.1, PROJECT_ANALYSIS §8):
 *  1. Tab order from load: skip link is the first focusable.
 *  2. Skip-link activation target.
 *  3. Landmarks + heading hierarchy per route (one h1, no skipped levels).
 *  4. Drawer (compact "More"/menu): role=dialog + aria-modal, focus moves in, Tab is TRAPPED,
 *     Esc closes, focus returns to the invoking control, background aria-hidden.
 *  5. Visible focus ring on keyboard-focused controls (never outline:none).
 *  6. SPA route change: focus moves to the view h1 (tabindex=-1) + polite announcement +
 *     aria-current="page" on the active nav item.
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
    id: el.id || null,
    cls: typeof el.className === 'string' ? el.className : '',
    text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 50),
    tabindex: el.getAttribute('tabindex'),
    outline: getComputedStyle(el).outline,
  };
};

const structure = () => ({
  landmarks: {
    banner: document.querySelectorAll('header').length,
    navs: [...document.querySelectorAll('nav')].map((n) => n.getAttribute('aria-label')),
    mains: document.querySelectorAll('main').length,
  },
  headings: [...document.querySelectorAll('h1,h2,h3,h4')].map((h) => `${h.tagName}:${h.textContent.trim().slice(0, 30)}`),
  h1Count: document.querySelectorAll('h1').length,
  h1Tabindex: (document.querySelector('h1') || {}).getAttribute ? document.querySelector('h1').getAttribute('tabindex') : null,
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 320, height: 568 } });
const page = await context.newPage();
await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
await page.waitForSelector('.shell');

// 1. Tab order (first 12 stops)
const stops = [];
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  stops.push(await page.evaluate(activeInfo));
}
log('tab order (first 12, compact /today)', { stops });

// 2. Skip link activation
await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
await page.waitForSelector('.shell');
await page.keyboard.press('Tab');
await page.keyboard.press('Enter');
await page.waitForTimeout(150);
log('after skip-link Enter', { active: await page.evaluate(activeInfo), hash: await page.evaluate(() => location.hash) });

// 3. Structure per route (compact)
for (const route of ['#/today', '#/week', '#/all', '#/completed', '#/search', '#/settings', '#/list/01ARZ3NDEKTSV4RRFFQ69G5FAV', '#/nope']) {
  await page.goto(BASE + route, { waitUntil: 'load' });
  await page.waitForSelector('.shell');
  await page.waitForTimeout(150);
  log(`structure ${route}`, await page.evaluate(structure));
}

// 4. Drawer: open via the app bar menu button
await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
await page.waitForSelector('.shell');
await page.click('.appbar button'); // "Open navigation menu"
await page.waitForTimeout(300);
const drawerOpen = await page.evaluate(() => {
  const d = document.querySelector('.drawer');
  return {
    role: d ? d.getAttribute('role') : null,
    ariaModal: d ? d.getAttribute('aria-modal') : null,
    backgroundHidden: document.querySelector('.shell-body').getAttribute('aria-hidden'),
    active: (() => {
      const el = document.activeElement;
      return { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), inDrawer: !!el.closest('.drawer') };
    })(),
  };
});
log('drawer opened', drawerOpen);

// focus trap: 14 tabs must never leave the drawer
const trap = [];
for (let i = 0; i < 14; i++) {
  await page.keyboard.press('Tab');
  trap.push(await page.evaluate(() => !!document.activeElement.closest('.drawer')));
}
log('drawer focus trap (14 tabs)', { allInsideDrawer: trap.every(Boolean), trail: trap });

// Esc closes + focus returns to invoker
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
log('after Esc', await page.evaluate(() => {
  const el = document.activeElement;
  return {
    drawerPresent: !!document.querySelector('.drawer'),
    backgroundHidden: document.querySelector('.shell-body').getAttribute('aria-hidden'),
    active: { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) },
  };
}));

// 5. Focus-visible ring on a nav item (keyboard)
await page.keyboard.press('Tab');
const ring = await page.evaluate(activeInfo);
log('focus ring sample', { active: ring });

// 6. SPA route change: focus to h1 + announcement + aria-current
await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
await page.waitForSelector('.shell');
await page.click('.appbar button'); // drawer holds the nav links
await page.waitForTimeout(250);
await page.click('.drawer a[href="#/all"]');
await page.waitForTimeout(350);
log('route change to #/all', await page.evaluate(() => {
  const el = document.activeElement;
  const current = [...document.querySelectorAll('[aria-current="page"]')].map((n) => (n.textContent || '').trim().slice(0, 20));
  return {
    active: { tag: el.tagName.toLowerCase(), tabindex: el.getAttribute('tabindex'), text: (el.textContent || '').trim().slice(0, 40) },
    polite: (document.querySelector('[role="status"]') || {}).textContent,
    ariaCurrent: current,
    hash: location.hash,
  };
}));

await browser.close();
writeFileSync(new URL('./keyboard-probe-results.json', import.meta.url), JSON.stringify(out, null, 2));
