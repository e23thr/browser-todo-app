/**
 * Shared harness for the M13 WCAG 2.2 AA release-gate probes (task t_b788bacf).
 *
 * Runs a REAL Chromium against the production build served by `vite preview`
 * (default http://127.0.0.1:4188/browser-todo-app/ — the non-root Pages base path).
 *
 * Env:
 *   APP_URL  — app URL under test (default as above)
 *   SRCDIR   — clean-HEAD src/ to read the i18n catalogs from (the shared tree may be dirty)
 *   EVIDIR   — evidence output dir (default: docs/qa/a11y-gate-logs next to this file)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

export const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4188/browser-todo-app/';
export const SRCDIR =
  process.env.SRCDIR ?? '/home/ubuntu/.hermes/profiles/h_reviewer/cache/scratch/a11y-gate-head/src';
export const EVIDIR =
  process.env.EVIDIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The i18n catalogs as shipped by the clean HEAD under test. */
export function loadCatalogs() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(SRCDIR, 'i18n', f), 'utf8'));
  return { en: read('en.json'), th: read('th.json') };
}

/** Format a catalog pattern the way t() does (`{param}` interpolation only). */
export function fmt(pattern, params = {}) {
  return pattern.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

export function writeEvidence(name, data) {
  fs.mkdirSync(EVIDIR, { recursive: true });
  const file = path.join(EVIDIR, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(`[evidence] ${file}`);
  return file;
}

export async function launch() {
  return chromium.launch();
}

/**
 * A fresh browser context + page with the app booted and first-run onboarding dismissed.
 * `opts`: { viewport, colorScheme, locale, isMobile, hasTouch, deviceScaleFactor }
 */
export async function bootPage(browser, catalogs, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    colorScheme: opts.colorScheme ?? 'light',
    locale: opts.locale ?? 'en-US',
    isMobile: opts.isMobile ?? false,
    hasTouch: opts.hasTouch ?? false,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(APP_URL);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(400);
  await dismissOnboarding(page, catalogs);
  return { context, page, errors };
}

/** First-run onboarding replaces the whole shell; dismiss it via its CTA. */
export async function dismissOnboarding(page, catalogs) {
  const cta = page.locator('[data-surface="onboarding"] .onboarding-actions button');
  if ((await cta.count()) > 0) {
    await cta.first().click();
    await page.waitForTimeout(300);
  }
}

/** Switch language through the real Settings UI (radio in the Language radiogroup). */
export async function setLanguage(page, catalogs, lang) {
  await page.goto(`${APP_URL}#/settings`);
  await page.waitForTimeout(300);
  // A stray dialog (e.g. left open by an earlier mobile step) would shadow the settings
  // form — close whatever is open before touching the radios.
  for (let i = 0; i < 3; i++) {
    const openDialog = page.locator('.dialog-layer .dialog:visible, .dialog:visible').last();
    if ((await openDialog.count()) === 0) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  const label =
    lang === 'th' ? catalogs.th['settings.language.thai'] : catalogs.en['settings.language.english'];
  // Click the visible label — the path a human takes — and fall back to a forced input check.
  const labelEl = page.locator('label', { hasText: label }).first();
  try {
    await labelEl.click({ timeout: 8000 });
  } catch {
    await page.getByRole('radio', { name: label, exact: true }).first().check({ force: true, timeout: 8000 });
  }
  await page.waitForTimeout(600);
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  if (htmlLang !== lang) throw new Error(`html lang is "${htmlLang}" after switching to ${lang}`);
}

/** Create the given lists through the real Lists UI. Returns {name: id}. */
export async function createLists(page, catalogs, names) {
  const ids = {};
  for (const name of names) {
    await page.goto(`${APP_URL}#/lists`);
    await page.waitForTimeout(250);
    await page.getByRole('button', { name: catalogs.en['list.action.new'], exact: true }).first().click();
    await page.waitForTimeout(200);
    const dialog = page.locator('.dialog').last();
    await dialog.locator('input[type="text"]').first().fill(name);
    await page.waitForTimeout(120);
    await dialog.locator('button.button-primary').first().click();
    await page.waitForTimeout(350);
    const row = page.locator(`.list-row[data-list-id]`, { hasText: name }).first();
    const li = await row.evaluate((el) => el.getAttribute('data-list-id')).catch(() => null);
    ids[name] = li;
  }
  return ids;
}

/** Add tasks through the real composer on the All-open view (FAB fallback on compact). */
export async function addTasks(page, titles) {
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(300);
  const input = page.locator('main .composer input[type="text"], .fab-composer input[type="text"], .sheet input[type="text"], .dialog input[type="text"]').first();
  if ((await input.count()) === 0) {
    // Compact/mobile layout: no inline composer — the FAB (or empty-state CTA) opens it.
    const cta = page.locator('.fab, main .empty-state button.button-primary').first();
    if ((await cta.count()) > 0) {
      await cta.click();
      await page.waitForTimeout(400);
    }
  }
  for (const title of titles) {
    if ((await input.count()) === 0) {
      const cta = page.locator('.fab').first();
      if ((await cta.count()) > 0) {
        await cta.click();
        await page.waitForTimeout(400);
      }
    }
    await input.click();
    await input.fill(title);
    await page.waitForTimeout(80);
    await input.press('Enter');
    await page.waitForTimeout(350);
  }
  // Compact layouts open the composer as a sheet — close it so later steps aren't shadowed.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

/**
 * Install a MutationObserver that records every live-region text swap.
 * Returns a reader function; call readAnnounces() after acting.
 */
export async function installAnnounceRecorder(page) {
  await page.evaluate(() => {
    const store = { polite: [], assertive: [] };
    window.__ann = store;
    const wire = (sel, key) => {
      const el = document.querySelector(sel);
      if (el === null || el.__wired === true) return;
      el.__wired = true;
      new MutationObserver(() => {
        const text = (el.textContent ?? '').trim();
        if (text !== '') store[key].push(text);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    };
    wire('[role="status"][aria-live="polite"]', 'polite');
    wire('[role="alert"][aria-live="assertive"]', 'assertive');
  });
}

export async function readAnnounces(page) {
  return page.evaluate(() => window.__ann ?? { polite: [], assertive: [] });
}

export async function clearAnnounces(page) {
  await page.evaluate(() => {
    if (window.__ann) {
      window.__ann.polite = [];
      window.__ann.assertive = [];
    }
  });
}

/** Current focus as assistive tech sees it. */
export async function focusInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return { tag: 'body', role: null, name: '' };
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
    const name =
      el.getAttribute('aria-label') ??
      (el.labels && el.labels.length > 0 ? el.labels[0].textContent.trim() : null) ??
      el.textContent?.trim().slice(0, 80) ??
      '';
    return { tag: el.tagName.toLowerCase(), role, name, cls: el.className?.toString().slice(0, 60) ?? '' };
  });
}

/** WCAG 2.x relative-luminance contrast between two css colors (rgb/rgba/hex). */
export function parseColor(css) {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  const h = css.replace('#', '');
  if (h.length >= 6) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

export function contrastRatio(fg, bg) {
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const l1 = lum(fg);
  const l2 = lum(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite a possibly translucent fg over an opaque bg. */
export function composite(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}
