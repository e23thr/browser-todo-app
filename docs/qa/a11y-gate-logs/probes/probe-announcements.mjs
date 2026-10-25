/**
 * M13 gate probe 4 — live-region announcements, re-run with a CORRECT recorder.
 *
 * probe-visual's recorder installed twice and the second install swapped window.__ann while
 * the already-wired MutationObservers kept writing to the first store — every scenario read an
 * empty array. This probe installs exactly once, immediately after boot, before any navigation.
 */
import {
  APP_URL,
  addTasks,
  bootPage,
  clearAnnounces,
  createLists,
  installAnnounceRecorder,
  launch,
  loadCatalogs,
  readAnnounces,
  setLanguage,
  writeEvidence,
} from './lib.mjs';

const catalogs = loadCatalogs();
const S = (k, l = 'en') => catalogs[l][k];
const fmt = (p, params = {}) => p.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));

const out = { en: [], th: [], notes: [] };

function matches(msg, expect) {
  if (!expect) return false;
  // `{placeholder}` in an expectation stands for any value, so substitute BEFORE the
  // regex-escape pass — escaping first (as this did) dragged the braces through the
  // escape and the placeholder pass never matched, so every templated scenario
  // (route-change, search-results) read MISS whatever the region held. The M13 gate hit
  // that too and papered over it with the post-hoc "recheck" block in
  // announcements-gate.json; M13-B1 (t_419ace90) fixes the matcher in place so the count
  // this probe prints is the count the gate counts.
  const rx =
    '^' +
    expect
      .split(/\{\w+\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+') +
    '$';
  return new RegExp(rx).test(msg);
}

async function run(locale) {
  const l = locale;
  const rows = [];
  const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'light' });
  await createLists(page, catalogs, ['Home', 'Work']);
  await installAnnounceRecorder(page); // EXACTLY ONCE, before any route change
  if (locale === 'th') await setLanguage(page, catalogs, 'th');

  const scenario = async (name, expect, fn) => {
    await clearAnnounces(page);
    let err = null;
    try {
      await fn();
    } catch (e) {
      err = String(e.message ?? e).split('\n')[0];
    }
    await page.waitForTimeout(700);
    const ann = await readAnnounces(page);
    const all = [...ann.polite, ...ann.assertive];
    const hit = all.some((m) => matches(m, expect));
    rows.push({ scenario: name, expect, polite: ann.polite, assertive: ann.assertive, hit, ...(err ? { error: err } : {}) });
    console.log(`${locale} ${name}: ${hit ? 'HIT' : 'MISS'} — polite=${JSON.stringify(ann.polite)}`);
  };

  await scenario('task-added', fmt(S('a11y.taskAdded', l), { title: locale === 'th' ? 'เพิ่มงานใหม่' : 'Announce add' }), async () => {
    await page.goto(`${APP_URL}#/all`);
    await page.waitForTimeout(400);
    const input = page.locator('main .composer input[type="text"]').first();
    await input.click();
    await input.fill(locale === 'th' ? 'เพิ่มงานใหม่' : 'Announce add');
    await input.press('Enter');
  });

  await scenario('task-completed', S('a11y.taskCompleted', l), async () => {
    const check = page.locator('main li [type="checkbox"]').first();
    await check.check({ force: true });
    await page.waitForTimeout(300);
  });

  await scenario('task-reopened', S('a11y.taskReopened', l), async () => {
    await page.goto(`${APP_URL}#/completed`);
    await page.waitForTimeout(500);
    const check = page.locator('main li [type="checkbox"]').first();
    await check.uncheck({ force: true });
    await page.waitForTimeout(300);
  });

  await scenario('route-change', S('a11y.viewChanged', l), async () => {
    await page.goto(`${APP_URL}#/week`);
    await page.waitForTimeout(500);
  });

  await scenario('search-results', S('a11y.searchResults', l), async () => {
    await page.goto(`${APP_URL}#/search`);
    await page.waitForTimeout(400);
    const field = page.locator('main input[type="search"], main input[type="text"]').first();
    await field.fill('a');
    await page.waitForTimeout(800);
  });

  await scenario('list-created', fmt(S('a11y.listCreated', l), { list: locale === 'th' ? 'รายการทดสอบ' : 'Announce list' }), async () => {
    await page.goto(`${APP_URL}#/lists`);
    await page.waitForTimeout(400);
    const btn = page
      .getByRole('button', { name: S('list.action.new', l), exact: true })
      .first();
    await btn.click();
    await page.waitForTimeout(300);
    const dlg = page.locator('.dialog').last();
    await dlg.locator('input[type="text"]').first().fill(locale === 'th' ? 'รายการทดสอบ' : 'Announce list');
    await dlg.locator('button.button-primary').first().click();
  });

  await context.close();
  out[locale] = rows;
}

const browser = await launch();
try {
  await run('en');
  await run('th');
} finally {
  await browser.close();
}

writeEvidence('announcements-gate.json', out);
const hits = [...out.en, ...out.th].filter((r) => r.hit).length;
console.log(`\nHITS: ${hits}/12`);
process.exit(0);
