/**
 * Functional verification probes — shared harness (task t_eff4b9fa).
 *
 * Evidence target: docs/qa/evidence/functional.md
 *
 * Runs a REAL Chromium against the production build served by `vite preview`
 * (APP_URL, default http://127.0.0.1:4290/browser-todo-app/ — the non-root Pages
 * base path). Everything is driven through the real UI (composer, editor, chips,
 * checkboxes, Settings → Storage & back up).
 *
 * Helpers here:
 *   - shot()        timestamped screenshot (ISO name + visible QA timestamp watermark)
 *   - dumpIdb()     raw IndexedDB snapshot of every database/store on the origin
 *   - canon()/diff canonical JSON + structural diff (fidelity comparisons)
 *   - captureConsole() full console/pageerror/requestfailed recording
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

/** Repo root: probes/ → functional-logs/ → evidence/ → qa/ → docs/ → <root>. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
export const EVIDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCREENS = path.join(EVIDIR, 'screens');
export const VIDEOS = path.join(EVIDIR, 'videos');
export const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4290/browser-todo-app/';

export const en = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'src', 'i18n', 'en.json'), 'utf8'),
);
export const th = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'src', 'i18n', 'th.json'), 'utf8'),
);

/** Regex matching a UI string by i18n key in EITHER locale (UI may be en or th). */
export function label(key) {
  const vals = [en[key], th[key]].filter((v) => typeof v === 'string');
  if (vals.length === 0) throw new Error(`no i18n label for ${key}`);
  const esc = vals.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(${esc})$`, 'u');
}

/** Loose variant (substring allowed, e.g. toast copy). */
export function labelLoose(key) {
  const vals = [en[key], th[key]].filter((v) => typeof v === 'string');
  const esc = vals.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(${esc})`, 'u');
}

export function writeJson(name, data) {
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
 * Timestamped screenshot: ISO-8601 UTC in the FILE NAME plus a visible
 * "QA <iso>" watermark burned into the frame, and a timeline entry.
 */
export async function shot(page, timeline, name, opts = {}) {
  const at = new Date().toISOString();
  await page.evaluate((ts) => {
    let el = document.getElementById('qa-stamp');
    if (el === null) {
      el = document.createElement('div');
      el.id = 'qa-stamp';
      document.body.appendChild(el);
    }
    el.textContent = `QA ${ts}`;
    el.style.cssText =
      'position:fixed;right:6px;bottom:6px;z-index:2147483647;' +
      'background:rgba(0,0,0,.7);color:#fff;font:12px/1.4 ui-monospace,monospace;' +
      'padding:2px 6px;border-radius:3px;pointer-events:none';
  }, at);
  fs.mkdirSync(SCREENS, { recursive: true });
  const file = path.join(SCREENS, `${at.replace(/[:.]/gu, '-')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  const entry = { step: name, at, screenshot: path.relative(REPO_ROOT, file) };
  timeline.push(entry);
  console.log(`[shot] ${entry.screenshot}`);
  return entry;
}

/** Record every console message, pageerror and failed request with wall-clock times. */
export function captureConsole(page, sink) {
  const line = (kind, text) => {
    sink.push({ at: new Date().toISOString(), kind, text });
  };
  page.on('console', (m) => line(`console.${m.type()}`, m.text()));
  page.on('pageerror', (e) => line('pageerror', e.message));
  page.on('requestfailed', (r) =>
    line('requestfailed', `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? '?'}`),
  );
}

export function consoleText(recs) {
  return recs.map((r) => `${r.at} ${r.kind.padEnd(16)} ${r.text}`).join('\n');
}

/**
 * Raw IndexedDB snapshot of the whole origin: every database, every object store,
 * every record — the "IndexedDB snapshot" evidence (before/after the refresh).
 */
export async function dumpIdb(page) {
  return page.evaluate(async () => {
    const out = {};
    const infos = await indexedDB.databases();
    for (const info of infos) {
      const name = info.name ?? '';
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open(name);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const stores = {};
      for (const storeName of Array.from(db.objectStoreNames)) {
        const rows = await new Promise((res, rej) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        stores[storeName] = rows;
      }
      out[name] = { version: db.version, stores };
      db.close();
    }
    return out;
  });
}

/** JSON round-trip that sorts object keys recursively — order-insensitive compare. */
export function canon(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Structural diff of two JSON values: paths where they differ. */
export function diff(a, b, basePath = '$') {
  const out = [];
  const walk = (x, y, p) => {
    if (canon(x) === canon(y)) return;
    const bothObjects =
      x !== null && y !== null && typeof x === 'object' && typeof y === 'object';
    if (!bothObjects || Array.isArray(x) !== Array.isArray(y)) {
      out.push({ path: p, before: x, after: y });
      return;
    }
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) walk(x?.[k], y?.[k], `${p}.${k}`);
  };
  walk(a, b, basePath);
  return out;
}
