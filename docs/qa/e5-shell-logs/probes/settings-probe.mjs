/**
 * QA probe (h_reviewer, task t_46150118) — settings persistence + localStorage audit.
 *
 * Checks:
 *  1. What lands in localStorage after boot and after settings changes (ADR-002 Decision 7:
 *     boot-critical prefs ONLY, <= 4 KiB).
 *  2. Theme + week start persist through the UI across reload (durable source of truth =
 *     the ADR-002 `settings` singleton record in IndexedDB, DB `local-first-todo`).
 *  3. ADR-002 §3.4 theme duplication rule: at boot the durable record WINS over the mirror
 *     and the mirror is rewritten when they disagree.
 *  4. `system` tracks prefers-color-scheme live without reload (design §5.1).
 *  5. Default-list control state (documented mount point; lists arrive with the domain card).
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:4273/browser-todo-app/';
const SETTINGS_URL = `${BASE}#/settings`;
const out = [];
const log = (step, data) => {
  out.push({ step, ...data });
  console.log(step, JSON.stringify(data));
};

const readState = () =>
  // eslint-disable-next-line no-undef
  ({
    localStorage: (() => {
      const o = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        o[k] = window.localStorage.getItem(k);
      }
      return o;
    })(),
    dataTheme: document.documentElement.getAttribute('data-theme'),
    colorScheme: document.documentElement.style.colorScheme,
    themeChecked: (document.querySelector('input[name="settings-theme"]:checked') || {}).value ?? null,
    weekStartChecked: (document.querySelector('input[name="settings-week-start"]:checked') || {}).value ?? null,
    defaultListValue: (document.querySelector('#settings-default-list') || {}).value ?? null,
    defaultListDisabled: (document.querySelector('#settings-default-list') || {}).disabled ?? null,
    defaultListOptions: [...document.querySelectorAll('#settings-default-list option')].map((o) => o.textContent),
    politeText: (document.querySelector('[role="status"]') || {}).textContent ?? null,
  });

const readIdbSettings = async () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open('local-first-todo');
    req.onerror = () => reject(new Error('idb open failed'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('settings', 'readonly');
        const get = tx.objectStore('settings').get('settings');
        get.onsuccess = () => {
          resolve(get.result ?? null);
          db.close();
        };
        get.onerror = () => reject(new Error('idb get failed'));
      } catch (e) {
        resolve(`no settings store: ${String(e)}`);
        db.close();
      }
    };
  });

const browser = await chromium.launch();
const context = await browser.newContext({ colorScheme: 'light' });
const page = await context.newPage();
page.on('pageerror', (e) => log('pageerror', { message: String(e) }));

await page.goto(SETTINGS_URL, { waitUntil: 'load' });
await page.waitForTimeout(400); // settings boot + idb load

log('boot state', await page.evaluate(readState));
log('boot idb settings record', { record: await page.evaluate(readIdbSettings) });

// --- 1. change theme -> dark, week start -> Monday through the UI ---
await page.check('input[name="settings-theme"][value="dark"]');
await page.check('input[name="settings-week-start"][value="1"]');
await page.waitForTimeout(500); // fire-and-forget durable save

log('after UI changes', await page.evaluate(readState));
log('after UI changes idb record', { record: await page.evaluate(readIdbSettings) });

// --- 2. reload: both must survive ---
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(400);
log('after reload', await page.evaluate(readState));
log('after reload idb record', { record: await page.evaluate(readIdbSettings) });

// --- 3. ADR-002 §3.4 conflict rule: corrupt the mirror, durable record must win + rewrite ---
await page.evaluate(() => window.localStorage.setItem('todo:prefs:v1:theme', 'light'));
log('mirror poisoned to light (idb still dark)', await page.evaluate(readState));
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(400);
log('after reload w/ poisoned mirror', await page.evaluate(readState));

// --- 4. live system tracking while pref = system ---
await page.check('input[name="settings-theme"][value="system"]');
await page.waitForTimeout(200);
const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(200);
const afterDark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(200);
const afterLight = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
log('live system tracking', { before, afterDark, afterLight });

// --- 5. localStorage budget ---
const bytes = await page.evaluate(() =>
  [...Array(window.localStorage.length).keys()].reduce(
    (n, i) => n + window.localStorage.key(i).length + window.localStorage.getItem(window.localStorage.key(i)).length,
    0,
  ),
);
log('localStorage total bytes', { bytes, budget: 4096, ok: bytes <= 4096 });

await browser.close();
writeFileSync(new URL('./settings-probe-results.json', import.meta.url), JSON.stringify(out, null, 2));
