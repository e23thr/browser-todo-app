// E8-UI-D5 fix evidence (t_2dec7c9d, h_senior_coder) — real-Chromium re-probe.
//   node qa-e8-fix-probe.mjs [port]   (against qa-e8-fix-dav.mjs on the same port)
//
// Drives the BUILT app's setup wizard against the fake WebDAV host and checks
// the SERVER-SIDE request log (not the client's claims) for the E8-UI-D5
// acceptance: the probe must contact the TYPED PATH, dead paths and wrong
// credentials must FAIL setup with the accurate copy.
//
//   A valid deep path  -> setup passes; the probe is PROPFIND on the TYPED PATH;
//                         a later "Sync now" runs against the same base.
//   B dead typed path  -> setup FAILS ("The storage folder is missing"), and the
//                         log shows the typed path WAS contacted.
//   C wrong credentials-> setup FAILS ("Sign-in rejected", never the CORS copy),
//                         and the log shows the typed path answered 401.

import { chromium } from '@playwright/test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 4195);
const APP = `http://localhost:${String(PORT)}/`;
const LOG = 'qa-e8-fix-dav-requests.jsonl';
const EVIDENCE = 'qa-e8-fix-evidence.jsonl';

writeFileSync(EVIDENCE, `--- run ${new Date().toISOString()} ---\n`);
writeFileSync(LOG, '');

let pass = 0;
let fail = 0;

function ev(phase, note, extra = {}) {
  appendFileSync(EVIDENCE, `${JSON.stringify({ phase, note, ...extra })}\n`);
  const mark = extra.ok === undefined ? 'INFO' : extra.ok ? 'PASS' : 'FAIL';
  console.log(
    `${mark} [${phase}] ${note}${extra.ok === undefined || extra.ok ? '' : ` :: ${JSON.stringify(extra)}`}`,
  );
}
function check(phase, cond, note, extra = {}) {
  if (cond) pass += 1;
  else fail += 1;
  ev(phase, note, { ...extra, ok: cond });
}
function logRows() {
  try {
    const text = readFileSync(LOG, 'utf8').trim();
    return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function newCtx() {
  const ctx = await browser.newContext();
  // Same priming the E8 QA probe uses: skip the onboarding screen (not under
  // test here) and record any CSP violation the WebDAV traffic might trip.
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
    } catch {
      /* hardened mode */
    }
    window.__csp = [];
    const rec = (e) =>
      window.__csp.push({ directive: e.violatedDirective ?? e.effectiveDirective, blockedURI: e.blockedURI });
    document.addEventListener('securitypolicyviolation', rec);
    window.addEventListener('securitypolicyviolation', rec);
  });
  return ctx;
}

async function openWizard(page) {
  await page.goto(APP);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1, exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'WebDAV address' }).waitFor();
}
async function fillAndSubmit(page, url, user, password) {
  await page.getByLabel('WebDAV address', { exact: true }).fill(url);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('User name', { exact: true }).fill(user);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Test connection & enable' }).click();
}
const hasSyncNow = async (page) => (await page.getByRole('button', { name: 'Sync now' }).count()) > 0;

const browser = await chromium.launch();

/* ---------------- A: valid credentials on a DEEP typed path ---------------- */
{
  const mark = logRows().length;
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openWizard(page);
  await fillAndSubmit(page, `http://localhost:${String(PORT)}/dav/deep/nested/coll/`, 'alice', 'correct-horse');
  await page.getByRole('button', { name: 'Sync now' }).waitFor({ timeout: 10_000 });
  check('A', await hasSyncNow(page), 'A1 setup COMPLETES for valid credentials on the deep typed path');

  const rows = logRows().slice(mark);
  const probe = rows.find((r) => r.method === 'PROPFIND' && r.path === '/dav/deep/nested/coll/');
  check('A', probe !== undefined, 'A2 the probe request hits the TYPED PATH /dav/deep/nested/coll/', {
    requests: rows.map((r) => `${r.method} ${r.path}`),
  });
  check(
    'A',
    rows.every((r) => r.path !== '/' || r.method === 'GET') &&
      rows.filter((r) => r.method !== 'GET').every((r) => r.path.startsWith('/dav/')) &&
      rows.filter((r) => r.method === 'PROPFIND').length === 1,
    'A3 the ORIGIN ROOT is only ever loaded as the app shell — the setup phase makes exactly ONE engine request: PROPFIND on the typed path',
    { engineRequests: rows.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`) },
  );

  // The run uses the SAME endpoint family the probe validated.
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.waitForTimeout(2500);
  const runRows = logRows().slice(mark);
  check(
    'A',
    runRows.some((r) => r.path.startsWith('/dav/deep/nested/coll/todo-sync/')),
    'A4 "Sync now" runs against the same configured base (/dav/deep/nested/coll/todo-sync/…)',
    { requests: runRows.map((r) => `${r.method} ${r.path}`) },
  );
  const bodyText = await page.locator('body').innerText();
  check('A', bodyText.includes('Last synced:'), 'A5 status surface shows Last synced after the run');
  const csp = await page.evaluate(() => window.__csp ?? []);
  check('A', csp.length === 0, 'A6 zero CSP violations from the probe/run traffic', { csp });
  await ctx.close();
}

/* ---------------- B: dead typed path must FAIL setup ---------------- */
{
  const mark = logRows().length;
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openWizard(page);
  await fillAndSubmit(page, `http://localhost:${String(PORT)}/dav/dead/path/`, 'alice', 'correct-horse');
  await page.getByTestId('setup-error').waitFor({ timeout: 10_000 });
  const errorText = await page.getByTestId('setup-error').innerText();
  check('B', !(await hasSyncNow(page)), 'B1 a dead configured path FAILS setup (no status surface)');
  check(
    'B',
    errorText.includes('The storage folder is missing'),
    'B2 the error names the MISSING folder (REMOTE_MISSING — accurate)',
    { errorText },
  );
  check(
    'B',
    !errorText.includes('The browser blocked the request'),
    'B3 the failure is NOT misattributed to CORS',
    { errorText },
  );
  const rows = logRows().slice(mark);
  check(
    'B',
    rows.some((r) => r.method === 'PROPFIND' && r.path === '/dav/dead/path/'),
    'B4 the TYPED dead path WAS contacted by the probe (log evidence)',
    { requests: rows.map((r) => `${r.method} ${r.path}`) },
  );
  await ctx.close();
}

/* ---------------- C: wrong credentials must FAIL setup ---------------- */
{
  const mark = logRows().length;
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await openWizard(page);
  await fillAndSubmit(page, `http://localhost:${String(PORT)}/dav/deep/nested/coll/`, 'alice', 'wrong-pw');
  await page.getByTestId('setup-error').waitFor({ timeout: 10_000 });
  const errorText = await page.getByTestId('setup-error').innerText();
  check('C', !(await hasSyncNow(page)), 'C1 wrong credentials FAIL setup (rolled back, no status surface)');
  check('C', errorText.includes('Sign-in rejected'), 'C2 the 401 is attributed to the SIGN-IN (AUTH)', {
    errorText,
  });
  check(
    'C',
    !errorText.includes('The browser blocked the request'),
    'C3 the 401 is NOT misattributed to CORS',
    { errorText },
  );
  const rows = logRows().slice(mark);
  const probe = rows.find((r) => r.method === 'PROPFIND' && r.path === '/dav/deep/nested/coll/');
  check('C', probe !== undefined && probe.authorization === 'wrong', 'C4 the probe hit the TYPED PATH with the WRONG credentials (401)', {
    requests: rows.map((r) => `${r.method} ${r.path} auth=${r.authorization}`),
  });
  await ctx.close();
}

await browser.close();
console.log(`\nRESULT: ${String(pass)} passed, ${String(fail)} failed`);
if (fail > 0) process.exitCode = 1;
