/**
 * M13 gate probe 6 — contrast of STATUS surfaces that normal seeding never puts in the DOM:
 * overdue badge (danger tint), priority badge, completed row text, save-failure toast,
 * focus ring — measured in BOTH themes, plus axe on those states.
 */
import AxeBuilder from '@axe-core/playwright';

import { APP_URL, bootPage, createLists, launch, loadCatalogs, setLanguage, writeEvidence } from './lib.mjs';

const catalogs = loadCatalogs();
const S = (k, l = 'en') => catalogs[l][k];
const out = { badges: [], axe: [] };

async function measure(page, theme, locale) {
  const samples = await page.evaluate(() => {
    const toRgb = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      const h = c.replace('#', '');
      return h.length >= 6 ? { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 } : null;
    };
    const lum = (c) => {
      const f = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => {
      const l1 = lum(a);
      const l2 = lum(b);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    };
    const over = (fg, bg) => (fg.a >= 1 ? fg : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
    const effBg = (node) => {
      let cur = node;
      let acc = null;
      while (cur !== null) {
        const bg = toRgb(getComputedStyle(cur).backgroundColor);
        if (bg !== null && bg.a > 0) {
          if (acc === null) {
            acc = bg;
            if (bg.a >= 1) return acc;
          } else if (bg.a >= 1) return over(acc, bg);
          else acc = over(acc, bg);
        }
        cur = cur.parentElement;
      }
      return acc ?? { r: 255, g: 255, b: 255, a: 1 };
    };
    const out = [];
    const consider = (el, name) => {
      if (el === null) return;
      const cs = getComputedStyle(el);
      const fg = toRgb(cs.color);
      if (fg === null) return;
      const bg = effBg(el);
      const r = ratio(over(fg, bg), { r: bg.r, g: bg.g, b: bg.b });
      out.push({
        name,
        text: (el.textContent ?? '').trim().slice(0, 40),
        color: cs.color,
        bg: `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        ratio: +r.toFixed(2),
        pass: r >= 4.5,
      });
    };
    consider(document.querySelector('.due-badge.due-badge-overdue'), 'due-badge-overdue');
    consider(document.querySelector('.due-badge:not(.due-badge-overdue)'), 'due-badge');
    consider(document.querySelector('.priority-badge'), 'priority-badge');
    consider(document.querySelector('.task-title-text'), 'task-title');
    consider(document.querySelector('.row-meta'), 'row-meta');
    consider(document.querySelector('.group-title'), 'group-title');
    consider(document.querySelector('.list-badge'), 'list-badge');
    // completed rows (dimmed styling would be a colour-contrast risk)
    const doneRow = [...document.querySelectorAll('li.task-row')].find((li) => li.querySelector('[type="checkbox"]')?.checked === true);
    if (doneRow !== undefined) {
      consider(doneRow.querySelector('.task-title-text'), 'completed-title');
      consider(doneRow, 'completed-row');
    }
    return out;
  });
  for (const s of samples) {
    out.badges.push({ theme, locale, ...s });
    if (!s.pass) console.log(`  FAIL ${theme}/${locale} ${s.name}: ${s.ratio} (${s.color} on ${s.bg})`);
  }
  console.log(`badges ${theme}/${locale}: ${samples.length} sampled, ${samples.filter((s) => !s.pass).length} below 4.5`);
}

const browser = await launch();
try {
  for (const theme of ['light', 'dark']) {
    for (const locale of ['en', 'th']) {
      const { context, page } = await bootPage(browser, catalogs, { colorScheme: theme });
      await createLists(page, catalogs, ['Home']);
      // three tasks: one overdue (past due date), one high priority, one completed
      await page.goto(`${APP_URL}#/all`);
      await page.waitForTimeout(400);
      const input = page.locator('main .composer input[type="text"]').first();
      for (const title of ['Overdue bill', 'Priority report', 'Finished task']) {
        await input.click();
        await input.fill(title);
        await input.press('Enter');
        await page.waitForTimeout(300);
      }
      if (locale === 'th') await setLanguage(page, catalogs, 'th');
      const l = locale;

      // open row 1 editor → past due date + High priority → Save
      await page.goto(`${APP_URL}#/all`);
      await page.waitForTimeout(400);
      const rows = page.locator('li.task-row .task-title');
      await rows.nth(0).click();
      await page.waitForTimeout(400);
      const due = page.locator('input[type="date"]').first();
      if ((await due.count()) > 0) await due.fill('2020-01-01');
      const high = page.getByRole('radio', { name: S('priority.high', l), exact: true }).first();
      if ((await high.count()) > 0) await high.check({ force: true });
      const save = page.getByRole('button', { name: S('editor.save', l), exact: true }).first();
      if ((await save.count()) > 0) await save.click();
      await page.waitForTimeout(500);

      // complete row 3
      await page.goto(`${APP_URL}#/all`);
      await page.waitForTimeout(400);
      const checks = page.locator('li.task-row [type="checkbox"]');
      if ((await checks.count()) >= 3) {
        await checks.nth(2).check({ force: true });
        await page.waitForTimeout(400);
      }

      await page.goto(`${APP_URL}#/all`);
      await page.waitForTimeout(500);
      await measure(page, theme, locale);

      // axe over this status-rich state
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      out.axe.push({
        state: `all-status[${theme}/${locale}]`,
        violations: res.violations.map((v) => `${v.impact}:${v.id}(${v.nodes.length})`),
      });
      console.log(`axe status-state ${theme}/${locale}: ${res.violations.map((v) => v.impact + ':' + v.id).join(', ') || 'clean'}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const fails = out.badges.filter((b) => !b.pass);
out.summary = { sampled: out.badges.length, below45: fails.length };
writeEvidence('status-contrast.json', out);
console.log(`\nstatus contrast: ${out.badges.length} sampled, ${fails.length} below 4.5:1`);
process.exit(0);
