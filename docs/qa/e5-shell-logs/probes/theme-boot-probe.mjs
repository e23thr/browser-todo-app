/**
 * QA probe (h_reviewer, task t_46150118) — independent no-flash theme boot verification.
 *
 * Method: before ANY page script runs, wrap Element.prototype.setAttribute so the exact
 * synchronous moment the boot snippet writes <html data-theme> is timestamped with
 * performance.now(), and a buffered PerformanceObserver records first-contentful-paint.
 * The theme is flash-free iff the data-theme write lands at-or-before FCP on every load.
 * Each scenario is run unthrottled AND under 6x CPU throttling (the impl's e2e has no
 * throttled run). Also verifies style.colorScheme and the final resolved theme.
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const THEME_KEY = 'todo:prefs:v1:theme';
const LOADS_PER_SCENARIO = 3;

const PROBE_INIT = `
  window.__probe = { setAttr: null, mut: [], fcp: null };
  (function () {
    var orig = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this === document.documentElement && name === 'data-theme' && window.__probe.setAttr === null) {
        window.__probe.setAttr = { value: String(value), t: performance.now() };
      }
      return orig.call(this, name, value);
    };
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === 'data-theme') {
          window.__probe.mut.push({ v: document.documentElement.getAttribute('data-theme'), t: performance.now() });
        }
      }
    });
    (function observe() {
      if (document.documentElement) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      else setTimeout(observe, 0);
    })();
    try {
      new PerformanceObserver(function (list) {
        for (var i = 0; i < list.getEntries().length; i++) {
          if (list.getEntries()[i].name === 'first-contentful-paint') window.__probe.fcp = list.getEntries()[i].startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (e) { /* no paint observer */ }
  })();
`;

/** pref: stored mirror value (null = absent); os: emulated prefers-color-scheme. */
const SCENARIOS = [
  { name: 'explicit light, OS dark', pref: 'light', os: 'dark', expect: 'light' },
  { name: 'explicit dark, OS light', pref: 'dark', os: 'light', expect: 'dark' },
  { name: 'system, OS dark', pref: 'system', os: 'dark', expect: 'dark' },
  { name: 'system, OS light', pref: 'system', os: 'light', expect: 'light' },
  { name: 'absent pref, OS dark', pref: null, os: 'dark', expect: 'dark' },
  { name: 'absent pref, OS light', pref: null, os: 'light', expect: 'light' },
  { name: 'invalid pref, OS dark', pref: 'banana', os: 'dark', expect: 'dark' },
];

const browser = await chromium.launch();
const runs = [];

for (const scenario of SCENARIOS) {
  for (const throttle of [1, 6]) {
    for (let load = 0; load < LOADS_PER_SCENARIO; load++) {
      const context = await browser.newContext({ colorScheme: scenario.os });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      await page.addInitScript(PROBE_INIT);
      await page.addInitScript(
        ({ key, value }) => {
          if (value === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, value);
        },
        { key: THEME_KEY, value: scenario.pref },
      );
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForTimeout(150);
      const state = await page.evaluate(() => ({
        probe: window.__probe,
        dataTheme: document.documentElement.getAttribute('data-theme'),
        colorScheme: document.documentElement.style.colorScheme,
        keys: Object.keys(window.localStorage).sort(),
      }));
      const p = state.probe;
      const fcp = p.fcp;
      const setTime = p.setAttr ? p.setAttr.t : null;
      const flashFree =
        setTime !== null && (fcp === null ? true : setTime <= fcp) && state.dataTheme === scenario.expect;
      runs.push({
        scenario: scenario.name,
        pref: scenario.pref,
        os: scenario.os,
        cpuThrottle: throttle,
        load: load + 1,
        expectedTheme: scenario.expect,
        dataTheme: state.dataTheme,
        colorScheme: state.colorScheme,
        setAttrTime: setTime,
        mutTime: p.mut.length ? p.mut[0].t : null,
        fcp,
        marginMs: fcp !== null && setTime !== null ? +(fcp - setTime).toFixed(2) : null,
        flashFree,
        storageKeys: state.keys,
      });
      await context.close();
    }
  }
}

await browser.close();
writeFileSync(new URL('./theme-boot-results.json', import.meta.url), JSON.stringify(runs, null, 2));

const bad = runs.filter((r) => !r.flashFree);
const margins = runs.filter((r) => r.marginMs !== null).map((r) => r.marginMs);
console.log(`runs: ${runs.length}, flash-free: ${runs.length - bad.length}, violations: ${bad.length}`);
console.log(
  `margin (FCP - data-theme) ms: min ${Math.min(...margins)} max ${Math.max(...margins)} (positive = theme applied BEFORE first paint)`,
);
for (const r of bad) console.log('VIOLATION:', JSON.stringify(r));
const keySets = [...new Set(runs.map((r) => JSON.stringify(r.storageKeys)))];
console.log('localStorage key sets seen:', keySets.join(' | '));
