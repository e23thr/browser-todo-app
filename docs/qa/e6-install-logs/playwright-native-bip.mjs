#!/usr/bin/env node
/**
 * E6 install QA — native beforeinstallprompt capture race on the repo's bundled Playwright
 * Chromium (fresh profile: visit 1 = first visit, visit 2 = warm with active SW).
 * Measures: native BIP time vs install-notice-root mount (= bootInstallFlow attach) and
 * whether the app preventDefault'd (captured) the native event; then behavioural offer check.
 */
import { chromium } from '@playwright/test';

const URL_ = 'http://127.0.0.1:4183/browser-todo-app/';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.addInitScript(() => {
  window.__m = { bip: null, root: null, prev: null, n: 0 };
  window.addEventListener('beforeinstallprompt', (e) => {
    window.__m.n += 1;
    if (window.__m.bip === null) window.__m.bip = Math.round(performance.now());
    setTimeout(() => {
      window.__m.prev = String(e.defaultPrevented);
    }, 600);
  });
  document.addEventListener('DOMContentLoaded', () => {
    const mo = new MutationObserver(() => {
      const el = document.getElementById('install-notice-root');
      if (el && window.__m.root === null) {
        window.__m.root = Math.round(performance.now());
        mo.disconnect();
      }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true });
  });
});

const snap = async (label) => {
  const m = await page.evaluate(() => window.__m);
  console.log(label, JSON.stringify(m));
  return m;
};

// visit 1 — fresh profile, no SW
await page.goto(URL_);
await page.waitForTimeout(4000);
await snap('visit1-fresh (ms after nav):');
const gs = page.getByRole('button', { name: 'Get started', exact: true });
if ((await gs.count()) > 0) await gs.click();
await page.waitForTimeout(500);

// visit 2 — warm (SW active in profile)
await page.goto(URL_);
await page.waitForTimeout(3000);
const v2 = await snap('visit2-warm (ms after nav):');

// behavioural: first task of this session — does the native capture produce the offer?
await page.evaluate(() => {
  location.hash = '#/all';
});
await page.waitForTimeout(800);
const newList = page.getByRole('button', { name: 'New list', exact: true });
if ((await newList.count()) > 0) {
  await newList.click();
  await page.getByLabel('List name', { exact: true }).fill('Native Playwright List');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(800);
}
const composer = page.locator('[placeholder="Add task…"]');
if ((await composer.count()) > 0) {
  await composer.fill('Playwright native probe task');
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await page.waitForTimeout(1500);
}
const offerCount = await page.locator('[data-install-notice]').count();
const taskSeen = (await page.locator('body').innerText()).includes('Playwright native probe task');
console.log('task created:', taskSeen);
console.log(
  'offer after first task (native capture only):',
  offerCount > 0 ? (await page.locator('[data-install-notice]').innerText()).replace(/\n/g, ' | ') : 'ABSENT',
);
await snap('final:');
await browser.close();
