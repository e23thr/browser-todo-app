/** (a) exact children of .task-list that trip axe's `list` rule; (b) axe matrix at 360px touch. */
import AxeBuilder from '@axe-core/playwright';

import { APP_URL, addTasks, bootPage, createLists, launch, loadCatalogs, writeEvidence } from './lib.mjs';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const catalogs = loadCatalogs();
const out = { children: null, mobileScans: [] };

async function scan(page, label) {
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const v = res.violations.map((x) => ({
    id: x.id,
    impact: x.impact,
    nodes: x.nodes.length,
    target: x.nodes[0]?.target?.join(' ') ?? '',
    summary: x.nodes[0]?.failureSummary ?? '',
  }));
  out.mobileScans.push({ label, violations: v });
  console.log(`mobile ${label}: ${v.map((x) => `${x.impact}:${x.id}(${x.nodes})`).join(', ') || 'clean'}`);
}

const browser = await launch();
try {
  const { context, page } = await bootPage(browser, catalogs, {
    colorScheme: 'light',
    viewport: { width: 360, height: 740 },
    isMobile: true,
    hasTouch: true,
  });
  await createLists(page, catalogs, ['Home', 'Work']);
  await addTasks(page, ['Buy milk', 'Pay electricity bill', 'Send monthly report']);

  await page.goto(`${APP_URL}#/all`);
  await page.waitForTimeout(400);
  out.children = await page.evaluate(() => {
    const ul = document.querySelector('ul.task-list');
    if (ul === null) return null;
    return [...ul.children].map((c) => ({
      tag: c.tagName.toLowerCase(),
      role: c.getAttribute('role'),
      cls: c.className,
      ariaHidden: c.getAttribute('aria-hidden'),
      text: (c.textContent ?? '').trim().slice(0, 40),
    }));
  });

  for (const route of ['', '#/all', '#/completed', '#/lists', '#/settings']) {
    await page.goto(`${APP_URL}${route}`);
    await page.waitForTimeout(400);
    await scan(page, route || '/');
  }
  await context.close();
} finally {
  await browser.close();
}
writeEvidence('axe-mobile-list.json', out);
console.log('task-list children:', JSON.stringify(out.children, null, 1));
process.exit(0);
