/**
 * M13 gate probe 1 — axe-core coverage of the ASSEMBLED MVP UI.
 *
 * The CI spec (tests/e2e/a11y.spec.ts) never dismisses first-run onboarding, so at HEAD it
 * only ever scans the onboarding screen. This probe dismisses onboarding, seeds real data,
 * and scans: onboarding itself, every route, and the interactive states (menus, dialogs,
 * drawer, sheet) across BOTH themes and BOTH locales.
 */
import AxeBuilder from '@axe-core/playwright';

import {
  APP_URL,
  addTasks,
  bootPage,
  createLists,
  dismissOnboarding,
  launch,
  loadCatalogs,
  setLanguage,
  writeEvidence,
} from './lib.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ROUTES = ['', '#/today', '#/week', '#/all', '#/completed', '#/search', '#/lists', '#/list/REPLACE', '#/settings'];

const catalogs = loadCatalogs();
const S = (k, l = 'en') => catalogs[l][k];

const out = { appUrl: APP_URL, tags: TAGS, scans: [], blocking: [], notes: [] };

async function scan(page, label) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const violations = res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.length,
    target: v.nodes[0]?.target?.join(' ') ?? '',
  }));
  out.scans.push({ label, violations, passes: res.passes.length, incomplete: res.incomplete.length });
  for (const v of violations) {
    if (v.impact === 'serious' || v.impact === 'critical') {
      out.blocking.push({ label, ...v });
    }
  }
  console.log(`scan ${label}: ${violations.length} violation(s)${violations.length ? ' — ' + violations.map((v) => `${v.impact}:${v.id}`).join(', ') : ''}`);
}

/** Seed a workspace with lists + representative tasks (incl. completed/overdue/priority/notes). */
async function seed(page, locale) {
  const l = locale === 'th' ? 'th' : 'en';
  const listNames = locale === 'th' ? ['งานบ้าน', 'ที่ทำงาน'] : ['Home', 'Work'];
  await createLists(page, catalogs, listNames);
  const titles =
    locale === 'th'
      ? ['ซื้อนมสด', 'จ่ายค่าไฟฟ้า', 'ส่งรายงานประจำเดือน', 'อ่านหนังสือ']
      : ['Buy milk', 'Pay electricity bill', 'Send monthly report', 'Read a book'];
  await addTasks(page, titles);

  // Make one task completed (non-color status surface needs real data to exist).
  const first = page.locator('main li [type="checkbox"]').first();
  if ((await first.count()) > 0) {
    await first.check();
    await page.waitForTimeout(400);
  }

  // Give one task a past due date + high priority via the editor (best effort).
  try {
    await page.goto(`${APP_URL}#/all`);
    await page.waitForTimeout(300);
    await page.locator('main li .task-title').first().click();
    await page.waitForTimeout(400);
    const due = page.locator('.dialog input[type="date"], .editor input[type="date"], input[type="date"]').first();
    if ((await due.count()) > 0) {
      await due.fill('2020-01-01');
      const high = page.getByRole('radio', { name: S('priority.high', l), exact: true }).first();
      if ((await high.count()) > 0) await high.check();
      const save = page.getByRole('button', { name: S('editor.save', l), exact: true }).first();
      if ((await save.count()) > 0) await save.click();
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    } else {
      await page.keyboard.press('Escape');
    }
  } catch (e) {
    out.notes.push(`seed editor step skipped (${locale}): ${e.message.split('\n')[0]}`);
  }
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(300);
}

/** Interactive-state scans on the All-open view. */
async function interactiveScans(page, locale, tag) {
  const l = locale === 'th' ? 'th' : 'en';

  // 1. row menu open
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(300);
  const trigger = page.locator('.row-menu-trigger').first();
  if ((await trigger.count()) > 0) {
    await trigger.click();
    await page.waitForTimeout(200);
    await scan(page, `${tag}/row-menu-open`);
    await page.keyboard.press('Escape');
  } else out.notes.push(`no row menu trigger (${tag})`);

  // 2. move-to-list dialog
  await trigger.click().catch(() => {});
  const moveItem = page.getByRole('menuitem', { name: S('task.action.moveToList', l), exact: true }).first();
  if ((await moveItem.count()) > 0) {
    await moveItem.click();
    await page.waitForTimeout(300);
    await scan(page, `${tag}/move-to-list-dialog`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else out.notes.push(`no move-to-list menuitem (${tag})`);

  // 3. delete confirm dialog
  await trigger.click().catch(() => {});
  const delItem = page.getByRole('menuitem', { name: S('task.action.delete', l), exact: true }).first();
  if ((await delItem.count()) > 0) {
    await delItem.click();
    await page.waitForTimeout(300);
    await scan(page, `${tag}/delete-confirm-dialog`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } else out.notes.push(`no delete menuitem (${tag})`);

  // 4. composer expanded (details)
  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(300);
  const expander = page.locator('.composer-expander').first();
  if ((await expander.count()) > 0) {
    await expander.click();
    await page.waitForTimeout(250);
    await scan(page, `${tag}/composer-expanded`);
  } else out.notes.push(`no composer expander (${tag})`);

  // 5. list management: rename field + delete disposition dialog
  await page.goto(`${APP_URL}#/lists`);
  await page.waitForTimeout(300);
  const rename = page.getByRole('button', { name: S('list.action.rename', l), exact: true }).first();
  if ((await rename.count()) > 0) {
    await rename.click();
    await page.waitForTimeout(250);
    await scan(page, `${tag}/list-inline-rename`);
  }
  const delList = page.getByRole('button', { name: S('list.action.delete', l), exact: true }).first();
  if ((await delList.count()) > 0) {
    await delList.click();
    await page.waitForTimeout(300);
    await scan(page, `${tag}/list-delete-disposition-dialog`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
}

const browser = await launch();
try {
  // A. first-run onboarding (before dismissal) — light + dark
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    await page.waitForTimeout(500);
    await scan(page, `onboarding/${scheme}`);
    await context.close();
  }

  // B + C. routes and interactive states per theme × locale
  for (const scheme of ['light', 'dark']) {
    for (const locale of ['en', 'th']) {
      const { context, page } = await bootPage(browser, catalogs, { colorScheme: scheme });
      const themeAttr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (themeAttr !== scheme) out.notes.push(`theme boot: expected data-theme=${scheme}, got ${themeAttr}`);

      await seed(page, locale);
      if (locale === 'th') {
        try {
          await setLanguage(page, catalogs, 'th');
        } catch (e) {
          out.notes.push(`language switch to th failed: ${e.message}`);
        }
      }

      let listId = 'REPLACE';
      try {
        const id = await page.locator('.list-row[data-list-id]').first().getAttribute('data-list-id');
        if (id) listId = id;
      } catch {
        /* empty workspace */
      }

      for (const route of ROUTES) {
        const r = route.replace('REPLACE', listId);
        await page.goto(`${APP_URL}${r}`);
        await page.waitForTimeout(350);
        await scan(page, `route:${r || '/'}[${scheme}/${locale}]`);
      }

      await interactiveScans(page, locale, `${scheme}/${locale}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}

out.summary = {
  totalScans: out.scans.length,
  scansWithViolations: out.scans.filter((s) => s.violations.length > 0).length,
  blockingCount: out.blocking.length,
  allViolationIds: [...new Set(out.scans.flatMap((s) => s.violations.map((v) => `${v.impact}:${v.id}`)))],
};
writeEvidence('axe-gate.json', out);
console.log(`\nBLOCKING (serious/critical): ${out.blocking.length}`);
for (const b of out.blocking) console.log(`  ${b.label} → ${b.impact}:${b.id} — ${b.help} (${b.nodes} node(s)) ${b.target}`);
console.log(`\nAll distinct violations: ${out.summary.allViolationIds.join(', ') || 'none'}`);
process.exit(0);
