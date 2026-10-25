import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  } catch {}
  window.__csp = [];
  const rec = (e) => window.__csp.push({ directive: e.violatedDirective, blockedURI: e.blockedURI, sample: e.sample });
  document.addEventListener('securitypolicyviolation', rec);
  window.addEventListener('securitypolicyviolation', rec);
});
const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
await page.goto('http://localhost:4193/#/settings', { waitUntil: 'load' });
await page.waitForSelector('[data-testid="sync-panel"]', { timeout: 15000 });

const out = await page.evaluate(async () => {
  const results = {};
  const attempts = {
    crossGet: { url: 'http://127.0.0.1:4194/dav/', init: {} },
    crossOptions: { url: 'http://127.0.0.1:4194/dav/', init: { method: 'OPTIONS' } },
    crossCustomHeader: { url: 'http://127.0.0.1:4194/dav/', init: { method: 'OPTIONS', headers: { 'X-QA-Header': 'probe' } } },
    otherOriginGet: { url: 'http://example.com/', init: {} },
    sameGet: { url: 'http://localhost:4193/manifest.webmanifest', init: {} },
  };
  for (const [name, spec] of Object.entries(attempts)) {
    try {
      const r = await fetch(spec.url, spec.init);
      results[name] = `resolved:${String(r.status)}`;
    } catch (e) {
      results[name] = `rejected:${e.name}:${String(e.message ?? e)}`;
    }
  }
  results.__csp = window.__csp;
  return results;
});
console.log(JSON.stringify(out, null, 1));
console.log('--- console ---');
console.log(consoleMsgs.filter((m) => m.includes('Content-Security') || m.includes('Refused') || m.includes('CSP')).join('\n') || '<no CSP console messages>');
await browser.close();
