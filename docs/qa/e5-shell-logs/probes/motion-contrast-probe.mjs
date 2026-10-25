/**
 * QA probe (h_reviewer, t_46150118) — prefers-reduced-motion + contrast spot checks.
 *
 * Motion (design §10.3): under prefers-reduced-motion: reduce, durations must collapse to 1ms,
 * scroll-behavior must be auto, and transform-based motion must be gone (FAB press -> fill
 * change, drawer appears without slide).
 *
 * Contrast (PROJECT_ANALYSIS §8, design §12.2): compute WCAG 2.x ratios for the token pairs
 * listed in §12.2 in BOTH themes and compare against the spec's measured values; then verify
 * representative rendered elements actually resolve to those tokens.
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const out = [];
const log = (step, data) => {
  out.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};

// [label, fgToken, bgToken, specLight, specDark, minRatio]
const PAIRS = [
  ['text/surface', '--color-text', '--color-surface', 16.5, 14.6, 4.5],
  ['secondary/surface', '--color-text-secondary', '--color-surface', 6.1, 8.1, 4.5],
  ['tertiary/surface', '--color-text-tertiary', '--color-surface', 5.4, 6.3, 4.5],
  ['tertiary/surface-hover', '--color-text-tertiary', '--color-surface-hover', 4.6, 4.9, 4.5],
  ['accent-text/surface', '--color-accent-text', '--color-surface', 7.4, 7.6, 4.5],
  ['on-accent/accent', '--color-on-accent', '--color-accent', 6.9, 5.1, 4.5],
  ['on-danger/danger', '--color-on-danger', '--color-danger', 6.5, 5.1, 4.5],
  ['border-control/surface', '--color-border-control', '--color-surface', 3.7, 4.1, 3],
  ['focus/surface', '--color-focus', '--color-surface', 6.9, 7.6, 3],
  ['danger-text/danger-tint', '--color-danger-text', '--color-danger-tint', 6.6, 7.3, 4.5],
  ['success-text/success-tint', '--color-success-text', '--color-success-tint', 6.3, 7.8, 4.5],
  ['warning-text/warning-tint', '--color-warning-text', '--color-warning-tint', 6.5, 8.0, 4.5],
  ['info-text/info-tint', '--color-info-text', '--color-info-tint', 5.8, 7.0, 4.5],
];

const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg, bg) => {
  const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return +((l1 + 0.05) / (l2 + 0.05)).toFixed(2);
};
const expandHex = (s) => {
  const t = s.trim();
  const short = t.match(/^#([0-9a-f]{3})$/i);
  if (short) return `#${short[1][0]}${short[1][0]}${short[1][1]}${short[1][1]}${short[1][2]}${short[1][2]}`;
  return t;
};
const parseable = (s) => typeof s === 'string' && (/^#([0-9a-f]{6})$/i.test(expandHex(s)) || /\d/.test(s));

const parseRgb = (s) => {
  const hex = expandHex(s).match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
};

const TOKENS = [...new Set(PAIRS.flatMap(([, f, b]) => [f, b]))];

const browser = await chromium.launch();

for (const theme of ['light', 'dark']) {
  // --- motion under prefers-reduced-motion ---
  {
    const context = await browser.newContext({
      viewport: { width: 320, height: 568 },
      reducedMotion: 'reduce',
      colorScheme: theme,
    });
    const page = await context.newPage();
    await page.addInitScript((t) => window.localStorage.setItem('todo:prefs:v1:theme', t), theme);
    await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
    await page.waitForSelector('.shell');
    await page.click('.appbar button'); // drawer animation enters the picture
    await page.waitForTimeout(100);
    const motion = await page.evaluate(() => {
      const cs = (s) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el) : null;
      };
      const fab = cs('.fab');
      const drawer = cs('.drawer');
      const btn = cs('.button');
      const segment = cs('.segment');
      return {
        fab: fab && { transitionDuration: fab.transitionDuration, transform: fab.transform },
        drawer: drawer && { animationDuration: drawer.animationDuration, animationName: drawer.animationName, transform: drawer.transform },
        button: btn && { transitionDuration: btn.transitionDuration },
        segment: segment && { transitionDuration: segment.transitionDuration },
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        htmlScrollBehavior: getComputedStyle(document.body).scrollBehavior,
      };
    });
    await page.screenshot({ path: new URL(`./shots/reduced-motion-${theme}-drawer.png`, import.meta.url).pathname });
    log(`reduced-motion (${theme})`, motion);
    await context.close();
  }

  // --- baseline motion (no reduce) for comparison ---
  {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, colorScheme: theme });
    const page = await context.newPage();
    await page.addInitScript((t) => window.localStorage.setItem('todo:prefs:v1:theme', t), theme);
    await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
    await page.waitForSelector('.shell');
    const motion = await page.evaluate(() => {
      const fab = document.querySelector('.fab');
      return {
        fabTransition: getComputedStyle(fab).transitionDuration,
        fabTransformRule: getComputedStyle(fab).transform,
      };
    });
    log(`baseline motion (${theme})`, motion);
    await context.close();
  }

  // --- contrast: tokens + rendered elements ---
  {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: theme });
    const page = await context.newPage();
    await page.addInitScript((t) => window.localStorage.setItem('todo:prefs:v1:theme', t), theme);
    await page.goto(`${BASE}#/settings`, { waitUntil: 'load' });
    await page.waitForSelector('.shell');
    await page.waitForTimeout(300);
    await page.screenshot({ path: new URL(`./shots/contrast-${theme}-settings.png`, import.meta.url).pathname });

    const tokens = await page.evaluate((names) => {
      const cs = getComputedStyle(document.documentElement);
      const outT = { dataTheme: document.documentElement.getAttribute('data-theme') };
      for (const n of names) outT[n] = cs.getPropertyValue(n).trim();
      return outT;
    }, TOKENS);

    const elements = await page.evaluate(() => {
      const pick = (sel, label) => {
        const el = document.querySelector(sel);
        if (!el) return { label, missing: true };
        const cs = getComputedStyle(el);
        return {
          label,
          color: cs.color,
          background: cs.backgroundColor,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
        };
      };
      return [
        pick('h1', 'view h1'),
        pick('.settings-heading', 'settings h2'),
        pick('.field-label', 'field label'),
        pick('.tab .tab-label', 'tab label'),
        pick('.button-primary', 'primary button'),
        pick('.segment', 'segment label'),
      ];
    });

    const measured = PAIRS.map(([label, fg, bg, specL, specD, min]) => {
      const raw = { fg: tokens[fg], bg: tokens[bg] };
      if (!parseable(raw.fg) || !parseable(raw.bg)) return { label, unparseable: raw };
      const r = ratio(parseRgb(raw.fg), parseRgb(raw.bg));
      const spec = theme === 'light' ? specL : specD;
      return { label, fg: tokens[fg], bg: tokens[bg], ratio: r, spec, match: Math.abs(r - spec) <= 0.15, meetsBar: r >= min };
    });
    log(`contrast tokens (${theme})`, { dataTheme: tokens.dataTheme, pairs: measured });
    log(`rendered elements (${theme})`, { elements });
    await context.close();
  }

  // --- compact chrome elements: tab label + primary button + FAB on /today ---
  {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, colorScheme: theme });
    const page = await context.newPage();
    await page.addInitScript((t) => window.localStorage.setItem('todo:prefs:v1:theme', t), theme);
    await page.goto(`${BASE}#/today`, { waitUntil: 'load' });
    await page.waitForSelector('.shell');
    await page.waitForTimeout(200);
    const chrome = await page.evaluate(() => {
      const pick = (sel, label) => {
        const el = document.querySelector(sel);
        if (!el) return { label, missing: true };
        const cs = getComputedStyle(el);
        return { label, color: cs.color, background: cs.backgroundColor };
      };
      return [
        pick('.tab .tab-label', 'tab label (active)'),
        pick('.tabbar .tab:nth-child(2) .tab-label', 'tab label (inactive)'),
        pick('.button-primary', 'primary button'),
        pick('.fab', 'FAB'),
        pick('.appbar', 'app bar'),
      ];
    });
    log(`compact chrome elements (${theme})`, {
      chrome: chrome.map((c) =>
        c.missing ? c : { ...c, ratio: ratio(parseRgb(c.color), parseRgb(c.background)) },
      ),
    });
    await context.close();
  }
}

await browser.close();
writeFileSync(new URL('./motion-contrast-results.json', import.meta.url), JSON.stringify(out, null, 2));
