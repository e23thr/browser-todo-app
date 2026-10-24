import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { APP_URL } from './helpers';

/**
 * h_reviewer probe for t_64b514e2 (E2 M5/M6 review: search, reorder, virtualization) —
 * NOT part of the product suite.
 *
 * Covers what the jsdom component suites cannot:
 *   1. axe over the M5/M6 surfaces (search results with <mark>, per-list view with reorder
 *      handles, move-to-list dialog, virtualized list with pad spacers).
 *   2. Real-pointer reproduction of two suspected drag defects (self-slot drop, drop onto
 *      the task's own list in the sidebar).
 *   3. Virtualization facts at >200 rows in a real browser (DOM row count, keyboard
 *      navigation across the window boundary, aria-posinset/setsize).
 */

async function scan(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const lines = results.violations.map((violation) => {
    const nodes = violation.nodes
      .map((node) => `      node: ${node.html.slice(0, 200)} | ${node.target.join(' ')}`)
      .join('\n');
    return `${violation.impact ?? 'unknown'}: ${violation.id} — ${violation.help} (${String(violation.nodes.length)} node(s))\n${nodes}`;
  });
  console.log(`AXE[${label}]: ${lines.length > 0 ? `\n  ${lines.join('\n  ')}` : 'clean'}`);
  return lines;
}

const blockingSeen: string[] = [];

async function scanBlocking(page: Page, label: string): Promise<void> {
  for (const line of await scan(page, label)) {
    if (line.startsWith('serious:') || line.startsWith('critical:')) {
      blockingSeen.push(`${label} → ${line}`);
    }
  }
}

async function seed(page: Page): Promise<void> {
  await page.goto(APP_URL);
  const onboardingCta = page.getByRole('button', { name: 'Get started', exact: true });
  if ((await onboardingCta.count()) > 0) {
    await onboardingCta.click();
  }
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();

  const newListButton = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newListButton.count()) > 0) {
    await newListButton.first().click();
    await page.getByLabel('List name', { exact: true }).fill('Probe List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
}

/** The Probe List sidebar link — the FIRST list link may be a pre-existing default. */
function probeListLink(page: Page) {
  return page.locator('a[href^="#/list/"]').filter({ hasText: 'Probe List' }).first();
}

/** Add `titles` through the real composer while ON the Probe List route (F1.4 default). */
async function addTasks(page: Page, titles: string[]): Promise<void> {
  await probeListLink(page).click();
  await expect(page.getByRole('heading', { name: 'Probe List', level: 1 })).toBeVisible();
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await expect(composer).toBeVisible();
  for (const title of titles) {
    await composer.fill(title);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('listitem').filter({ hasText: titles[0] as string })).toBeVisible();
}

test('reviewer probe: axe over search results, per-list handles, move dialog', async ({ page }) => {
  await seed(page);
  await addTasks(page, ['Buy milk', 'Water plants', 'Review invoice beta']);

  // Search surface (S5): results with <mark> highlighting.
  await page.goto(`${APP_URL}#/search`);
  const search = page.getByRole('searchbox');
  await search.fill('milk');
  await expect(page.getByRole('listitem').filter({ hasText: 'Buy milk' })).toBeVisible();
  await scanBlocking(page, 'search results (populated, <mark>)');
  const markCount = await page.locator('mark').count();
  console.log(`FACT search <mark> count for "milk": ${String(markCount)}`);

  // Per-list view: reorder handles present (D1: per-list only).
  const listHref = await probeListLink(page).getAttribute('href');
  await page.goto(`${APP_URL}${listHref ?? '#/all'}`);
  await expect(page.getByRole('listitem').filter({ hasText: 'Buy milk' })).toBeVisible();
  const handles = await page.locator('[data-reorder-handle]').count();
  const rows = await page.locator('li.task-row').count();
  console.log(`FACT per-list handles=${String(handles)} rows=${String(rows)}`);
  await scanBlocking(page, 'per-list view with reorder handles');

  // Reorder handle: 44 px target + accessible name.
  const handleFacts = await page.evaluate(() => {
    const handle = document.querySelector<HTMLElement>('[data-reorder-handle]');
    if (handle === null) return 'no handle';
    const r = handle.getBoundingClientRect();
    return JSON.stringify({
      w: Math.round(r.width),
      h: Math.round(r.height),
      name: handle.getAttribute('aria-label'),
      tag: handle.tagName,
    });
  });
  console.log(`FACT handle: ${handleFacts}`);

  // Move-to-list dialog (F11).
  const row = page.getByRole('listitem').filter({ hasText: 'Buy milk' });
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Move to list…', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scanBlocking(page, 'move-to-list dialog (F11)');
  const radios = await page.getByRole('dialog').getByRole('radio').count();
  console.log(`FACT move dialog radios: ${String(radios)}`);
  await page.keyboard.press('Escape');

  // Search view Alt+arrow (D1: reorder unavailable).
  await page.goto(`${APP_URL}#/search`);
  await page.getByRole('searchbox').fill('milk');
  await expect(page.getByRole('listitem').filter({ hasText: 'Buy milk' })).toBeVisible();
  const noHandle = await page.locator('[data-reorder-handle]').count();
  console.log(`FACT search-result handles (expect 0): ${String(noHandle)}`);
  await expect(page.locator('[data-reorder-handle]')).toHaveCount(0);

  console.log(
    `SERIOUS/CRITICAL SUMMARY (${String(blockingSeen.length)}):\n${blockingSeen.join('\n=====\n') || 'none'}`,
  );
  expect(blockingSeen, 'serious/critical axe violations on M5/M6 surfaces').toEqual([]);
});

test('reviewer probe: drag into own slot must not raise a save failure', async ({ page }) => {
  await seed(page);
  await addTasks(page, ['One alpha', 'Two beta', 'Three gamma']);
  const listLink = page.locator('a[href^="#/list/"]').filter({ hasText: 'Probe List' }).first();
  const listHref = await listLink.getAttribute('href');
  await page.goto(`${APP_URL}${listHref ?? '#/all'}`);
  await expect(page.getByRole('listitem').filter({ hasText: 'Two beta' })).toBeVisible();

  // Drag row 2 by its handle ~8 px down: the pointer stays inside row 2's lower
  // half → drop intent resolves to the slot row 2 already occupies.
  const handle = page.locator('[data-reorder-handle]').nth(1);
  const box = await handle.boundingBox();
  if (box === null) throw new Error('no handle box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 12, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const toast = await page.locator('[role="alert"]').allTextContents();
  const live = await page.locator('[aria-live]').allTextContents();
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('li.task-row .task-title-text')].map((el) => el.textContent),
  );
  console.log(`PROBE-E toasts: ${JSON.stringify(toast)}`);
  console.log(`PROBE-E live regions: ${JSON.stringify(live)}`);
  console.log(`PROBE-E order: ${JSON.stringify(order)}`);
  const failed = toast.some((t) => t.includes("Couldn't save"));
  expect(failed, 'self-slot drop must not raise a save-failure toast').toBe(false);
});

test('reviewer probe: drag onto own list in the sidebar must not reorder', async ({ page }) => {
  await seed(page);
  await addTasks(page, ['One alpha', 'Two beta', 'Three gamma']);
  const listLink = page.locator('a[href^="#/list/"]').filter({ hasText: 'Probe List' }).first();
  const listHref = await listLink.getAttribute('href');
  await page.goto(`${APP_URL}${listHref ?? '#/all'}`);
  await expect(page.getByRole('listitem').filter({ hasText: 'One alpha' })).toBeVisible();

  const handle = page.locator('[data-reorder-handle]').first();
  const sidebarOwn = page.locator('a[data-drop-list-id]').first();
  const hb = await handle.boundingBox();
  const sb = await sidebarOwn.boundingBox();
  if (hb === null || sb === null) throw new Error('no geometry');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2, { steps: 10 });
  const hoverAttr = await sidebarOwn.getAttribute('data-drop-hover');
  console.log(`PROBE-F own-list highlighted during drag: ${String(hoverAttr)}`);
  await page.mouse.up();
  await page.waitForTimeout(400);

  const order = await page.evaluate(() =>
    [...document.querySelectorAll('li.task-row .task-title-text')].map((el) => el.textContent),
  );
  const live = await page.locator('[aria-live]').allTextContents();
  console.log(`PROBE-F order after own-list drop: ${JSON.stringify(order)}`);
  console.log(`PROBE-F live: ${JSON.stringify(live)}`);
  expect(order, 'task must stay first when dropped on its own list').toEqual([
    'One alpha',
    'Two beta',
    'Three gamma',
  ]);
});

test('reviewer probe: virtualization at 210+ rows in a real browser', async ({ page }) => {
  await seed(page);
  await page.goto(`${APP_URL}#/all`);
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await expect(composer).toBeVisible();
  for (let i = 1; i <= 210; i += 1) {
    await composer.fill(`Bulk task ${String(i)}`);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('listitem').filter({ hasText: 'Bulk task 1' })).toBeVisible();
  // Composer.submit refocuses its title in addTask().then() (D6 "save and stay"):
  // let the last queued write settle so it cannot steal focus from the row probe.
  await page.waitForTimeout(2500);

  const domRows = await page.locator('li.task-row').count();
  const virtualized = await page.locator('ul.task-list[data-virtualized="true"]').count();
  console.log(`FACT virtualized attr=${String(virtualized)} DOM rows=${String(domRows)} of 210`);

  // Keyboard End → last row materialized + focused; posinset carries the real position.
  await page.locator('li.task-row').first().focus();
  const afterFocus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return `${el?.tagName ?? 'none'}.${el?.className ?? ''} taskId=${el?.getAttribute('data-task-id') ?? 'none'}`;
  });
  console.log(`FACT activeElement after row.focus(): ${afterFocus}`);
  await page.keyboard.press('End');
  await page.waitForTimeout(500);
  const endFacts = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const row = el?.closest('li.task-row') ?? null;
    return JSON.stringify({
      active: `${el?.tagName ?? 'none'}.${el?.className ?? ''}`,
      focusedTitle: row?.querySelector('.task-title-text')?.textContent ?? 'none',
      posinset: row?.getAttribute('aria-posinset') ?? null,
      setsize: row?.getAttribute('aria-setsize') ?? null,
      domRows: document.querySelectorAll('li.task-row').length,
    });
  });
  console.log(`FACT after End: ${endFacts}`);

  // ArrowDown x30 from wherever the cursor is: walk across window boundaries.
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await page.waitForTimeout(300);
  const arrowFacts = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const row = el?.closest('li.task-row') ?? null;
    return JSON.stringify({
      focusedTitle: row?.querySelector('.task-title-text')?.textContent ?? 'none',
      posinset: row?.getAttribute('aria-posinset') ?? null,
      domRows: document.querySelectorAll('li.task-row').length,
    });
  });
  console.log(`FACT after 30x ArrowDown: ${arrowFacts}`);

  await scanBlocking(page, 'virtualized list (210 rows, pad spacers)');
  const padFacts = await page.evaluate(() =>
    [...document.querySelectorAll('ul.task-list > li')]
      .filter((el) => !el.classList.contains('task-row') && !el.classList.contains('group-row'))
      .map((el) => `${el.tagName}.${el.className} role=${el.getAttribute('role') ?? '(none)'} aria-hidden=${el.getAttribute('aria-hidden') ?? '(no)'}`)
      .join(' | '),
  );
  console.log(`FACT non-row list children: ${padFacts || 'none'}`);

  // Scroll into the middle: DOM rows stay capped, positions stay real.
  await page.evaluate(() => {
    const rows = document.querySelectorAll<HTMLElement>('li.task-row');
    rows[Math.floor(rows.length / 2)]?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  const midFacts = await page.evaluate(() => {
    const first = document.querySelector('li.task-row');
    return JSON.stringify({
      domRows: document.querySelectorAll('li.task-row').length,
      firstPosinset: first?.getAttribute('aria-posinset') ?? null,
    });
  });
  console.log(`FACT mid-scroll: ${midFacts}`);

  console.log(
    `SERIOUS/CRITICAL SUMMARY (${String(blockingSeen.length)}):\n${blockingSeen.join('\n=====\n') || 'none'}`,
  );
  expect(blockingSeen, 'serious/critical axe violations on the virtualized list').toEqual([]);
});
