// E8 browser-level sync-UI probe (t_98a1b4a5, h_reviewer), v2.
// Real Chromium against the BUILT app, same-origin WebDAV double:
//   node qa-e8-browser-probe.mjs
// Phases: A opt-in boundary + keyboard wizard | B unreachable server |
// C wrong credentials (+ runtime 401) | D re-entry + valid setup |
// E local op zero sync traffic | F manual run + live regions |
// G offline attempt + recovery | H auto-sync toggle | I forget + prefill |
// J cross-origin CSP boundary. Evidence: qa-e8-browser-evidence.jsonl.
// Known defects documented by EXPECTED-CONDITION checks (they flip red when
// fixed): E8-UI-D4 (CSP connect-src 'self' blocks cross-origin sync),
// E8-UI-D5 (probe OPTIONSes the origin root, not the configured base path).

import { chromium } from '@playwright/test';
import { appendFileSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';

const APP = 'http://localhost:4193/';
const APP_ORIGIN = 'http://localhost:4193';
const CROSS = 'http://127.0.0.1:4194/dav/';
const DAV_LOG = 'qa-e8-dav-requests.jsonl';
const MOCK_LOG = 'qa-e8-mock-requests.jsonl';
const EVIDENCE = 'qa-e8-browser-evidence.jsonl';
const FLAG = 'qa-e8-rootdead';

writeFileSync(EVIDENCE, `--- run ${new Date().toISOString()} ---\n`);
writeFileSync(DAV_LOG, '');
if (existsSync(MOCK_LOG)) writeFileSync(MOCK_LOG, '');
if (existsSync(FLAG)) unlinkSync(FLAG);

let pass = 0;
let fail = 0;

function ev(phase, note, extra = {}) {
  appendFileSync(EVIDENCE, `${JSON.stringify({ phase, note, ...extra })}\n`);
  const mark = extra.ok === undefined ? 'INFO' : extra.ok ? 'PASS' : 'FAIL';
  console.log(`${mark} [${phase}] ${note}${extra.ok === undefined || extra.ok ? '' : ` :: ${JSON.stringify(extra)}`}`);
}
function check(phase, cond, note, extra = {}) {
  if (cond) pass += 1;
  else fail += 1;
  ev(phase, note, { ...extra, ok: cond });
}
function readJsonl(path) {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text === '') return [];
    return text.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
/** Engine-originated traffic: WebDAV paths, or any non-static method. */
const engineReqs = (pred = () => true) =>
  readJsonl(DAV_LOG)
    .filter((e) => e.path.startsWith('/dav') || (e.method !== 'GET' && e.method !== 'HEAD'))
    .filter(pred);
const mock4194 = () => readJsonl(MOCK_LOG);

async function activeInfo(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    return {
      tag: el.tagName,
      id: 'id' in el ? String(el.id ?? '') : '',
      href: el.getAttribute?.('href') ?? '',
      placeholder: el.getAttribute?.('placeholder') ?? '',
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 80),
    };
  });
}
async function tabTo(page, pred, max = 80) {
  const seq = [];
  for (let i = 0; i < max; i += 1) {
    const info = await activeInfo(page);
    seq.push(info);
    if (info !== null && pred(info)) return { found: true, seq, at: i };
    await page.keyboard.press('Tab');
  }
  return { found: false, seq, at: -1 };
}
/** Deterministic keyboard starting point: blur the current element (no pointer). */
const resetFocus = async (page) => {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
  });
};
/**
 * Keyboard-only robust replace of an input's value: focus (caller ensures),
 * Ctrl+A + Delete + type, then READ BACK — prepends/append artifacts (seen in
 * phase D under late focus effects) are caught here instead of silently
 * configuring a wrong remote URL.
 */
async function replaceInputValue(page, inputId, text) {
  await tabTo(page, (i) => i.id === inputId);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
  return page.locator(`#${inputId}`).inputValue().catch(() => null);
}
/**
 * Type into an input and VERIFY the full value landed; on partial loss
 * (intermittent focus/re-render race observed under load — recorded as a
 * report observation), refocus, reselect, and retype (max 3 attempts).
 */
async function typeVerified(page, inputId, text) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tabTo(page, (i) => i.id === inputId);
    await waitForFn(page, async () => (await activeInfo(page))?.id === inputId);
    if (last !== null) {
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
    }
    await page.keyboard.type(text, { delay: 20 });
    last = await page.locator(`#${inputId}`).inputValue().catch(() => null);
    if (last === text) return { value: last, attempts: attempt + 1 };
  }
  return { value: last, attempts: 3 };
}
/** Tab until activeElement matches a CSS selector (repo's own e2e convention). */
async function tabToSel(page, selector, max = 80) {
  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press('Tab');
    const on = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
    if (on) {
      await page.waitForTimeout(50);
      if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return true;
    }
  }
  return false;
}
const regionText = async (page, kind) =>
  page
    .locator(kind === 'polite' ? '[role="status"][aria-live="polite"]' : '[role="alert"][aria-live="assertive"]')
    .textContent()
    .catch(() => '');
const setupErrorText = async (page) => page.locator('[data-testid="setup-error"]').textContent().catch(() => null);
const syncErrorText = async (page) => page.locator('[data-testid="sync-error"]').textContent().catch(() => null);
const statusLine = async (page) => page.locator('[data-testid="sync-status-line"]').textContent().catch(() => null);
const hasSyncNow = async (page) => (await page.getByRole('button', { name: 'Sync now' }).count()) > 0;
const currentStep = async (page) => page.locator('li[aria-current="step"]').textContent().catch(() => '');

async function waitForFn(page, fn, timeout = 8000, interval = 100) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  } catch {
    /* hardened mode */
  }
  window.__csp = [];
  const rec = (e) => window.__csp.push({ directive: e.violatedDirective ?? e.effectiveDirective, blockedURI: e.blockedURI });
  document.addEventListener('securitypolicyviolation', rec);
  window.addEventListener('securitypolicyviolation', rec);
});
const page = await ctx.newPage();
const net = [];
page.on('request', (r) => net.push({ method: r.method(), url: r.url() }));
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
const external = () => net.filter((r) => !r.url.startsWith(APP_ORIGIN) && !r.url.startsWith('data:'));

try {
  /* ---------------- A. boot + opt-in boundary + keyboard step nav ---------------- */
  await page.goto(`${APP}#/settings`, { waitUntil: 'load' });
  await page.waitForSelector('[data-testid="sync-panel"]', { timeout: 15000 });
  await page.waitForSelector('text=Sync is off', { timeout: 10000 });
  check('A', external().length === 0, 'A1 zero NON-APP-origin requests after boot+render', { externalReqs: external() });
  check('A', engineReqs().length === 0, 'A2 zero WebDAV/probe requests before any setup submit', {
    engine: engineReqs().length,
  });

  const toUrl = await tabTo(page, (i) => i.id === 'sync-url');
  check('A', toUrl.found, 'A3 keyboard Tab reaches the WebDAV address field', {
    tabCount: toUrl.at,
    seq: toUrl.seq.map((s) => s?.name ?? '').filter(Boolean),
  });

  await page.keyboard.type('http://evil.example/dav/');
  await page.keyboard.press('Enter');
  const refusal = await waitForFn(page, async () => ((await setupErrorText(page)) ?? '').includes('HTTPS'));
  check('A', refusal, 'A4 insecure URL refused LOCALLY with HTTPS copy', { text: await setupErrorText(page) });
  ev('A', 'A5 local-refusal live-region observation [E8-UI-D3: expected announced]', {
    assertive: await regionText(page, 'assertive'),
    polite: await regionText(page, 'polite'),
  });
  check('A', engineReqs().length === 0, 'A6 local refusal made ZERO requests', { engine: engineReqs().length });

  const aVal = await replaceInputValue(page, 'sync-url', 'https://sync.example/dav/');
  check('A', aVal === 'https://sync.example/dav/', 'A7a URL replaced cleanly by keyboard (read-back verified)', { aVal });
  await page.keyboard.press('Enter');
  const step2 = await waitForFn(page, async () => (await currentStep(page)) === 'Sign-in details');
  check('A', step2, 'A7 Enter advances to step 2 (aria-current=step follows)', {
    stepAnnounce: await regionText(page, 'polite'),
  });
  const toBack = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Back');
  check('A', toBack.found, 'A8 keyboard Tab reaches the Back button', { tabCount: toBack.at });
  await page.keyboard.press('Enter');
  const backToUrl = await waitForFn(page, async () => (await activeInfo(page))?.id === 'sync-url');
  check('A', backToUrl, 'A9 Back returns focus to the URL field of step 1');
  check('A', engineReqs().length === 0 && external().length === 0, 'A10 entire pre-submit wizard interaction = ZERO requests', {
    engine: engineReqs().length,
    external: external().length,
    totalNet: net.length,
  });

  /* ---------------- B. unreachable server (root-dead flag: probe target dead) ---------------- */
  writeFileSync(FLAG, 'dead');
  const bVal = await replaceInputValue(page, 'sync-url', 'http://localhost:4193/dav-dead/');
  check('B', bVal === 'http://localhost:4193/dav-dead/', 'B0 URL replaced cleanly (read-back verified)', { bVal });
  await page.keyboard.press('Enter');
  await waitForFn(page, async () => (await currentStep(page)) === 'Sign-in details');
  await waitForFn(page, async () => (await activeInfo(page))?.id === 'sync-user');
  await tabTo(page, (i) => i.id === 'sync-user');
  await page.keyboard.type('alice');
  await page.keyboard.press('Tab');
  await page.keyboard.type('pw-unreachable');
  await page.keyboard.press('Enter');
  const bErr = await waitForFn(page, async () => (await setupErrorText(page)) !== null);
  const bText = bErr ? await setupErrorText(page) : '';
  check('B', bText.includes('The browser blocked the request') || bText.includes('Cannot reach the storage server'), 'B1 unreachable server -> graceful error copy (CORS/network-honest)', { text: bText });
  check('B', !(await hasSyncNow(page)), 'B2 setup NOT completed (still unconfigured)', {});
  const bAssertive = await waitForFn(page, async () =>
    (await regionText(page, 'assertive')).includes('Sync failed: The browser blocked the request'));
  check('B', bAssertive, 'B3 unreachable failure announced ASSERTIVELY', { assertive: await regionText(page, 'assertive') });
  const bProbes = engineReqs((e) => e.method === 'OPTIONS' && (e.path === '/' || e.path === ''));
  check('B', bProbes.length >= 1, 'B4 probe attempted the (dead) target', {
    probes: bProbes.length,
    note: 'probe targets the ORIGIN ROOT, not the typed base path — defect E8-UI-D5',
  });
  check('B', engineReqs((e) => e.path.startsWith('/dav/')).length === 0, 'B5 configured base path never contacted', {});
  unlinkSync(FLAG);

  /* ---------------- C. wrong credentials: setup ACCEPTS them (E8-UI-D5) ---------------- */
  const toBack2 = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Back');
  if (toBack2.found) await page.keyboard.press('Enter');
  await waitForFn(page, async () => (await activeInfo(page))?.id === 'sync-url');
  const cVal = await replaceInputValue(page, 'sync-url', 'http://localhost:4193/dav-bad/');
  check('C', cVal === 'http://localhost:4193/dav-bad/', 'C0 URL replaced cleanly (read-back verified)', { cVal });
  await page.keyboard.press('Enter');
  await waitForFn(page, async () => (await currentStep(page)) === 'Sign-in details');
  const keptUser = await page.locator('#sync-user').inputValue().catch(() => null);
  check('C', keptUser === 'alice', 'C1 wizard form state kept across failed submits', { user: keptUser });
  await page.keyboard.press('Enter');
  const cAccepted = await waitForFn(page, async () => (await statusLine(page)) !== null);
  const cErr = await setupErrorText(page);
  check('C', cAccepted === true && cErr === null, 'C2 DEFECT E8-UI-D5: wrong credentials ACCEPTED at setup (auth never validated)', {
    setupAccepted: cAccepted === true,
    setupError: cErr,
  });
  const cPolite = await waitForFn(page, async () => (await regionText(page, 'polite')).includes('Sync enabled'));
  check('C', cPolite, 'C3 "Sync enabled" announced despite wrong credentials', { polite: await regionText(page, 'polite') });
  check('C', engineReqs((e) => e.path.startsWith('/dav-bad')).length === 0, 'C4 configured path /dav-bad got ZERO setup requests (probe hit root only)', {
    bad: engineReqs((e) => e.path.startsWith('/dav-bad')),
  });

  // First real run discovers the truth: 401 at the configured path.
  const toSyncNow1 = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Sync now');
  check('C', toSyncNow1.found, 'C5 status surface rendered after (wrong-cred) setup', { tabCount: toSyncNow1.at });
  await page.keyboard.press('Enter');
  const cRunErr = await waitForFn(page, async () => ((await syncErrorText(page)) ?? '').length > 0, 15000);
  const cRunText = cRunErr ? await syncErrorText(page) : '';
  check('C', cRunText.includes('Sign-in rejected'), 'C6 wrong credentials surface at RUN time as Sign-in rejected (not at setup)', {
    text: cRunText?.slice(0, 160),
  });
  const cRunAssertive = await waitForFn(page, async () =>
    (await regionText(page, 'assertive')).includes('Sync failed: Sign-in rejected'));
  check('C', cRunAssertive, 'C7 run-time 401 announced ASSERTIVELY', { assertive: await regionText(page, 'assertive') });
  const cEnterCreds = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Enter credentials again');
  check('C', cEnterCreds.found, 'C8 AUTH error offers the re-entry affordance', { tabCount: cEnterCreds.at });

  /* ---------------- D. re-entry prefill + valid setup ---------------- */
  await page.keyboard.press('Enter');
  const dWizard = await waitForFn(page, async () => (await page.locator('#sync-url').count()) > 0);
  check('D', dWizard, 'D1 Enter credentials again opens the wizard');
  await tabTo(page, (i) => i.id === 'sync-url'); // focus the wizard field (step 1)
  const dPrefUrl = await page.locator('#sync-url').inputValue().catch(() => null);
  check('D', dPrefUrl === 'http://localhost:4193/dav-bad/', 'D2 prefill carries the stored address', { dPrefUrl });

  const dNewUrl = await replaceInputValue(page, 'sync-url', 'http://localhost:4193/dav/');
  check('D', dNewUrl === 'http://localhost:4193/dav/', 'D2b URL replaced cleanly before submit (read-back verified)', { dNewUrl });
  await page.keyboard.press('Enter');
  const dStep2 = await waitForFn(page, async () => (await currentStep(page)) === 'Sign-in details');
  check('D', dStep2, 'D3 re-entry advances to step 2');
  const dFocusUser = await waitForFn(page, async () => (await activeInfo(page))?.id === 'sync-user');
  check('D', dFocusUser === true, 'D3b wizard focus contract: step change focuses the user field');
  const dPrefUser = await page.locator('#sync-user').inputValue().catch(() => null);
  const dPrefPw = await page.locator('#sync-password').inputValue().catch(() => 'missing');
  check('D', dPrefUser === 'alice', 'D4 prefill carries the stored user', { dPrefUser });
  check('D', dPrefPw === '', 'D5 password NEVER read back from storage', { dPrefPw });
  const pwType = await page.locator('#sync-password').getAttribute('type').catch(() => null);
  check('D', pwType === 'password', 'D6 password field masked (type=password)', { pwType });

  await tabTo(page, (i) => i.id === 'sync-password');
  const dPw = await typeVerified(page, 'sync-password', 'pw-ok');
  check('D', dPw.value === 'pw-ok', 'D6b password typed into the field (read-back verified)', { dPw });
  const probesBefore = engineReqs((e) => e.method === 'OPTIONS' && (e.path === '/' || e.path === '')).length;
  await page.keyboard.press('Enter');
  const dOk = await waitForFn(page, async () => (await statusLine(page)) !== null);
  check('D', dOk, 'D7 valid setup completes -> status surface', { status: await statusLine(page) });
  const dEnabled = await waitForFn(page, async () => (await regionText(page, 'polite')).includes('Sync enabled'));
  check('D', dEnabled, 'D8 "Sync enabled" announced POLITELY', { polite: await regionText(page, 'polite') });
  const probesAfter = engineReqs((e) => e.method === 'OPTIONS' && (e.path === '/' || e.path === '')).length;
  check('D', probesAfter === probesBefore + 1, 'D9 setup traffic = ONE root OPTIONS probe (E8-UI-D5: root, not /dav/)', {
    probesBefore,
    probesAfter,
    probeTargets: engineReqs((e) => e.method === 'OPTIONS').map((e) => e.path),
  });
  check('D', engineReqs((e) => e.method === 'PROPFIND' || e.method === 'PUT').length === 0, 'D10 no surprise run after setup', {});
  check('D', external().length === 0, 'D11 zero cross-origin requests across the whole setup', { external: external() });
  check('D', ((await statusLine(page)) ?? '').includes('Not synced yet'), 'D12 initial status line = Not synced yet', {
    status: await statusLine(page),
  });

  /* ---------------- E. local operation never touches the sync host ---------------- */
  const toToday = await tabTo(page, (i) => i.href === '#/today');
  check('E', toToday.found, 'E1 keyboard reaches the Today nav link', { tabCount: toToday.at });
  await page.keyboard.press('Enter');
  const eHash = await waitForFn(page, async () => (await page.evaluate(() => location.hash)) === '#/today');
  check('E', eHash === true, 'E1b Today route actually active', { hash: await page.evaluate(() => location.hash) });
  await page.waitForSelector('.empty-state', { timeout: 10000 }).catch(() => {});
  await resetFocus(page);
  // Fresh profile: ZERO lists -> the composer shows its documented "New list" path.
  const eNewList = await tabToSel(page, '.composer-nolist button');
  check('E', eNewList, 'E2 keyboard reaches the composer New-list affordance (zero-list state)');
  await page.keyboard.press('Enter');
  const eDialog = await waitForFn(page, async () =>
    (await page.getByRole('dialog', { name: 'New list', exact: true }).count()) > 0);
  check('E', eDialog === true, 'E3 New list dialog opens by keyboard');
  // The dialog focuses its name field in an effect — wait for it (repo e2e does the same).
  const eNameFocused = await waitForFn(page, async () =>
    page.evaluate(() => document.activeElement?.matches('[role="dialog"] input[type="text"]') ?? false));
  check('E', eNameFocused === true, 'E3b dialog name field receives focus');
  await page.keyboard.type('QA sync');
  const eNameVal = await page
    .locator('[role="dialog"] input[type="text"]')
    .inputValue()
    .catch(() => null);
  check('E', eNameVal === 'QA sync', 'E3c list name typed into the dialog (read-back verified)', { eNameVal });
  await page.keyboard.press('Enter');
  const eDialogClosed = await waitForFn(page, async () =>
    (await page.getByRole('dialog', { name: 'New list', exact: true }).count()) === 0);
  check('E', eDialogClosed === true, 'E4 dialog submits by keyboard (closed)');
  const eListRow = await waitForFn(page, async () => {
    const names = await page.locator('a[href^="#/list/"]').allTextContents();
    return names.some((n) => n.includes('QA sync'));
  });
  check('E', eListRow === true, 'E4b list "QA sync" created and visible in the sidebar nav');
  ev('E', 'E4c post-create polite-region observation', { polite: await regionText(page, 'polite') });
  // Repo e2e convention: task creation is exercised on "#/all" (all open tasks).
  await resetFocus(page);
  const toAll = await tabTo(page, (i) => i.href === '#/all', 80);
  check('E', toAll.found, 'E5 keyboard reaches the All-open nav link', { tabCount: toAll.at });
  await page.keyboard.press('Enter');
  await waitForFn(page, async () => (await page.evaluate(() => location.hash)) === '#/all');
  await resetFocus(page);
  const engineBeforeE = engineReqs().length; // snapshot BEFORE the local write
  const eComposer = await tabToSel(page, '.composer-inline input[type="text"]');
  check('E', eComposer, 'E6 keyboard reaches the task composer input');
  await page.keyboard.type('Local keeper');
  await page.keyboard.press('Enter');
  const rowVisible = await waitForFn(page, async () => (await page.getByText('Local keeper', { exact: true }).count()) > 0);
  check('E', rowVisible, 'E7 local task created and visible');
  check('E', engineReqs().length === engineBeforeE, 'E8 local writes made ZERO sync requests', {
    delta: engineReqs().length - engineBeforeE,
  });

  /* ---------------- F. manual sync: status surface + live regions ---------------- */
  const toSettings2 = await tabTo(page, (i) => i.href === '#/settings');
  check('F', toSettings2.found, 'F0 keyboard reaches the Settings nav link from Today', { tabCount: toSettings2.at });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="sync-status-line"]', { timeout: 8000 });
  const toSyncNow2 = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Sync now');
  check('F', toSyncNow2.found, 'F1 keyboard reaches Sync now', { tabCount: toSyncNow2.at });
  const davBeforeRun = engineReqs().length;
  await page.keyboard.press('Enter');
  const fIdle = await waitForFn(page, async () => ((await statusLine(page)) ?? '').includes('Last synced:'), 15000);
  check('F', fIdle, 'F2 manual run completes -> Last synced: status line', { status: await statusLine(page) });
  const fPolite = await waitForFn(page, async () => (await regionText(page, 'polite')).includes('Sync finished'));
  check('F', fPolite, 'F3 "Sync finished" announced POLITELY', { polite: await regionText(page, 'polite') });
  const runReqs = engineReqs().slice(davBeforeRun);
  const methods = [...new Set(runReqs.map((r) => r.method))];
  check('F', methods.includes('PROPFIND') && methods.includes('PUT') && methods.includes('GET'), 'F4 run did real WebDAV (PROPFIND+PUT+GET read-back)', {
    methods,
    count: runReqs.length,
  });
  const nonProbeRun = runReqs.filter((r) => r.method !== 'OPTIONS');
  check('F', nonProbeRun.length > 0 && nonProbeRun.every((r) => r.path.startsWith('/dav/todo-sync')), 'F5 run traffic (beyond the root probe) hit the configured base path cleanly', {
    runProbeRoot: runReqs.filter((r) => r.method === 'OPTIONS').map((r) => r.path),
    runPaths: nonProbeRun.map((r) => `${r.method} ${r.path}`),
    nonBase: nonProbeRun.filter((r) => !r.path.startsWith('/dav/todo-sync')),
  });

  /* ---------------- G. offline attempt -> clear error, local data untouched ---------------- */
  const davBeforeOffline = engineReqs().length;
  await ctx.setOffline(true);
  const toSyncNow3 = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Sync now');
  if (toSyncNow3.found) await page.keyboard.press('Enter');
  const gErr = await waitForFn(page, async () => ((await syncErrorText(page)) ?? '').length > 0);
  const gText = gErr ? await syncErrorText(page) : '';
  check('G', gText.includes('Cannot reach the storage server') || gText.includes('The browser blocked the request'), 'G1 offline attempt -> visible error box with clear copy', {
    text: gText?.slice(0, 160),
  });
  const gAssertive = await waitForFn(page, async () => {
    const a = await regionText(page, 'assertive');
    return a.includes('Sync failed: Cannot reach the storage server') || a.includes('Sync failed: The browser blocked the request');
  });
  check('G', gAssertive, 'G2 offline failure announced ASSERTIVELY', { assertive: await regionText(page, 'assertive') });
  check('G', engineReqs().length === davBeforeOffline, 'G3 offline attempt made ZERO requests', {
    delta: engineReqs().length - davBeforeOffline,
  });
  await ctx.setOffline(false);
  const toSyncNow4 = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Sync now');
  if (toSyncNow4.found) await page.keyboard.press('Enter');
  const gRecovered = await waitForFn(page, async () =>
    ((await page.locator('[data-testid="sync-error"]').count()) === 0 &&
      ((await statusLine(page)) ?? '').includes('Last synced:')), 15000);
  check('G', gRecovered, 'G4 recovery: error cleared, status line back after going online', {
    status: await statusLine(page),
    polite: await regionText(page, 'polite'),
  });
  const toAll2 = await tabTo(page, (i) => i.href === '#/all');
  if (toAll2.found) {
    await page.keyboard.press('Enter');
    await waitForFn(page, async () => (await page.evaluate(() => location.hash)) === '#/all');
  }
  const rows = await waitForFn(page, async () => (await page.getByText('Local keeper', { exact: true }).count()) === 1);
  check('G', rows, 'G5 local data untouched across failed runs (row intact, exactly once)');

  /* ---------------- H. auto-sync toggle (keyboard) ---------------- */
  const toSettings3 = await tabTo(page, (i) => i.href === '#/settings');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#sync-auto', { timeout: 5000 });
  const davBeforeToggle = engineReqs().length;
  await tabTo(page, (i) => i.id === 'sync-auto');
  const before = await page.locator('#sync-auto').isChecked();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  const after1 = await page.locator('#sync-auto').isChecked();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  const after2 = await page.locator('#sync-auto').isChecked();
  check('H', before !== after1 && after1 !== after2, 'H1 auto-sync toggle flips by keyboard (Space)', { before, after1, after2 });
  check('H', engineReqs().length === davBeforeToggle, 'H2 toggling made ZERO sync requests', {
    delta: engineReqs().length - davBeforeToggle,
  });

  /* ---------------- I. forget wipes credentials (nothing left on device) ---------------- */
  const toForget = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Forget credentials');
  check('I', toForget.found, 'I1 keyboard reaches Forget credentials', { tabCount: toForget.at });
  await page.keyboard.press('Enter');
  const iWizard = await waitForFn(page, async () => (await page.locator('#sync-url').count()) > 0);
  check('I', iWizard, 'I2 forget returns to the setup wizard');
  const iPolite = await waitForFn(page, async () => (await regionText(page, 'polite')).includes('Sync off — credentials removed'));
  check('I', iPolite, 'I3 forget announced POLITELY', { polite: await regionText(page, 'polite') });
  const iUrl = await page.locator('#sync-url').inputValue().catch(() => null);
  check('I', iUrl === '', 'I4 forget WIPED the stored address (wizard re-emptied)', { iUrl });
  // Advance to step 2: the stored user must be gone too, and no password ever returns.
  const iVal = await replaceInputValue(page, 'sync-url', 'http://localhost:4193/dav/');
  check('I', iVal === 'http://localhost:4193/dav/', 'I3b temp URL typed cleanly (read-back verified)', { iVal });
  await page.keyboard.press('Enter');
  await waitForFn(page, async () => (await currentStep(page)) === 'Sign-in details');
  const iUser = await page.locator('#sync-user').inputValue().catch(() => null);
  const iPw = await page.locator('#sync-password').inputValue().catch(() => 'missing');
  check('I', iUser === '', 'I5 forget WIPED the stored user', { iUser });
  check('I', iPw === '', 'I6 password NEVER readable (empty on any re-entry)', { iPw });

  /* ---------------- J. cross-origin boundary: shipped CSP (E8-UI-D4) ---------------- */
  const jResult = await page.evaluate(async (target) => {
    try {
      const res = await fetch(target, { method: 'OPTIONS' });
      return `ok:${String(res.status)}`;
    } catch (e) {
      return `throw:${String(e)}`;
    }
  }, CROSS);
  await page.waitForTimeout(400);
  const violations = await page.evaluate(() => window.__csp ?? []);
  const cspConsole = consoleErrors.filter((m) => m.includes('Content Security Policy'));
  check('J', jResult.startsWith('throw'), 'J1 cross-origin WebDAV fetch BLOCKED in the shipped app', { jResult });
  check('J', violations.some((v) => String(v.blockedURI).includes('127.0.0.1:4194')) || cspConsole.length > 0, 'J2 connect-src CSP violation captured (events or console)', {
    violations,
    cspConsole,
  });
  // Wizard-level: user points setup at a healthy cross-origin host.
  const jBack = await tabTo(page, (i) => i.tag === 'BUTTON' && i.name === 'Back');
  if (jBack.found) await page.keyboard.press('Enter'); // step 2 -> step 1
  await waitForFn(page, async () => (await activeInfo(page))?.id === 'sync-url' || (await currentStep(page)) === 'Storage address');
  const jVal = await replaceInputValue(page, 'sync-url', CROSS);
  check('J', jVal === CROSS, 'J2b cross URL typed cleanly (read-back verified)', { jVal });
  await page.keyboard.press('Enter');
  await waitForFn(page, async () => (await currentStep(page)) === 'Sign-in details');
  await waitForFn(page, async () => (await activeInfo(page))?.id === 'sync-user');
  const jPw = await typeVerified(page, 'sync-password', 'pw-cross');
  check('J', jPw.value === 'pw-cross', 'J2c password typed into the field (read-back verified)', { jPw });
  await page.keyboard.press('Enter');
  const jErr = await waitForFn(page, async () => ((await setupErrorText(page)) ?? '').length > 0);
  const jText = jErr ? await setupErrorText(page) : '';
  check('J', jText.includes('The browser blocked the request') || jText.includes('Cannot reach the storage server'), 'J3 cross-origin setup fails (CSP blocks first; copy misattributes to CORS/server)', { text: jText });
  check('J', mock4194().length === 0, 'J4 healthy cross-origin host received ZERO requests (blocked pre-network)', {
    mockRequests: mock4194().length,
  });

  /* ---------------- final ---------------- */
  check('Z', external().length === 0, 'Z1 zero cross-origin requests for the ENTIRE session', {
    external: external().slice(0, 10),
  });
  ev('Z', 'final summary', { pass, fail, consoleErrors: consoleErrors.slice(0, 10), totalNet: net.length });
} catch (error) {
  ev('FATAL', String(error?.stack ?? error), { pass, fail });
  fail += 1;
} finally {
  await browser.close();
}
console.log(`\nRESULT pass=${String(pass)} fail=${String(fail)}`);
appendFileSync(EVIDENCE, `${JSON.stringify({ phase: 'RESULT', pass, fail })}\n`);
process.exit(fail > 0 ? 1 : 0);
