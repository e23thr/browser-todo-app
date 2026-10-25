import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  } catch {}
  window.__csp = [];
  const rec = (e) => window.__csp.push({ directive: e.violatedDirective, blockedURI: e.blockedURI });
  document.addEventListener('securitypolicyviolation', rec);
  window.addEventListener('securitypolicyviolation', rec);
});
const page = await ctx.newPage();
await page.goto('http://localhost:4193/#/settings', { waitUntil: 'load' });
await page.waitForSelector('[data-testid="sync-panel"]', { timeout: 15000 });
await page.waitForTimeout(2500); // let the service worker register

const result = await page.evaluate(async () => {
  const out = {};
  const swRegs = await navigator.serviceWorker.getRegistrations();
  out.swActive = swRegs.map((r) => ({ scope: r.scope, active: !!r.active }));
  try {
    const r = await fetch('http://localhost:4193/dav-dead/', { method: 'OPTIONS' });
    out.dead = `resolved:${String(r.status)}`;
  } catch (e) {
    out.dead = `rejected:${String(e)}`;
  }
  try {
    const r = await fetch('http://localhost:4193/dav/', { method: 'OPTIONS' });
    out.healthy = `resolved:${String(r.status)}`;
  } catch (e) {
    out.healthy = `rejected:${String(e)}`;
  }
  try {
    const r = await fetch('http://127.0.0.1:4194/dav/', { method: 'OPTIONS' });
    out.cross = `resolved:${String(r.status)}`;
  } catch (e) {
    out.cross = `rejected:${String(e)}`;
  }
  out.csp = window.__csp ?? [];
  return out;
});
console.log(JSON.stringify(result, null, 1));
const { readFileSync } = await import('node:fs');
try {
  console.log('dav log:\n' + readFileSync('qa-e8-dav-requests.jsonl', 'utf8'));
} catch {
  console.log('dav log: <missing>');
}
await browser.close();
