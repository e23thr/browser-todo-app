/** Resolve the 24 axe `incomplete` rule ids on interactive states (contrast can't be auto-decided there). */
import AxeBuilder from '@axe-core/playwright';

import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const catalogs = loadCatalogs();
const S = (k, l = 'en') => catalogs[l][k];
const out = { incomplete: [] };

async function scanIncomplete(page, label) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const inc of res.incomplete) {
    out.incomplete.push({ rule: inc.id, impact: inc.impact, label, nodes: inc.nodes.length, sample: inc.nodes[0]?.failureSummary?.slice(0, 200) ?? '' });
  }
  console.log(`${label}: incomplete=${res.incomplete.map((i) => `${i.id}(${i.nodes.length})`).join(', ') || 'none'}`);
}

const browser = await launch();
try {
  const { context, page } = await bootPage(browser, catalogs, { colorScheme: 'dark' });
  await createLists(page, catalogs, ['Home']);
  await addTasks(page, ['Buy milk', 'Pay bill']);

  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  const trigger = page.locator('.row-menu-trigger').first();
  await trigger.click();
  await page.waitForTimeout(250);
  await scanIncomplete(page, 'row-menu-open[dark]');
  await page.keyboard.press('Escape');

  await trigger.click().catch(() => {});
  const del = page.getByRole('menuitem', { name: S('task.action.delete'), exact: true }).first();
  if ((await del.count()) > 0) {
    await del.click();
    await page.waitForTimeout(300);
    await scanIncomplete(page, 'delete-dialog[dark]');
    await page.keyboard.press('Escape');
  }

  const expander = page.locator('.composer-expander').first();
  if ((await expander.count()) > 0) {
    await expander.click();
    await page.waitForTimeout(250);
    await scanIncomplete(page, 'composer-expanded[dark]');
  }
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('axe-incomplete.json', out);
const rules = [...new Set(out.incomplete.map((i) => i.rule))];
console.log(`\ndistinct incomplete rules: ${rules.join(', ') || 'none'}`);
process.exit(0);
