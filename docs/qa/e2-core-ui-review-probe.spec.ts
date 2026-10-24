import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { APP_URL } from './helpers';

/**
 * h_reviewer probe for t_3650ed00 (E2 core-UI review) — NOT part of the product suite.
 *
 * The shipped a11y.spec.ts scans the core routes on a FRESH profile, so it never sees a
 * populated row list, an open row menu, the task editor or the S7 confirm dialogs. This probe
 * seeds data through the real UI and scans those surfaces too, then records a few focus-model
 * facts (roving cursor, menu Tab behaviour, dialog focus return) for the review report.
 */

async function scan(page: Page, label: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const lines = results.violations.map((violation) => {
    const nodes = violation.nodes
      .map(
        (node) =>
          `      node: ${node.html.slice(0, 220)} | ${node.target.join(' ')} | data=${JSON.stringify(node.any.map((check) => check.data))} | ${node.failureSummary ?? ''}`,
      )
      .join('\n');
    return `${violation.impact ?? 'unknown'}: ${violation.id} — ${violation.help} (${String(violation.nodes.length)} node(s))\n${nodes}`;
  });
  console.log(`AXE[${label}]: ${lines.length > 0 ? `\n  ${lines.join('\n  ')}` : 'clean'}`);
  return lines;
}

const blockingSeen: string[] = [];

async function scanBlocking(page: Page, label: string): Promise<void> {
  const lines = await scan(page, label);
  for (const line of lines) {
    if (line.startsWith('serious:') || line.startsWith('critical:')) {
      blockingSeen.push(`${label} → ${line}`);
    }
  }
}

async function seed(page: Page): Promise<void> {
  await page.goto(APP_URL);
  // E3 first-run onboarding replaces the whole shell on a fresh profile (App.tsx).
  const onboardingCta = page.getByRole('button', { name: 'Get started', exact: true });
  if ((await onboardingCta.count()) > 0) {
    await onboardingCta.click();
  }
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible();

  const newListButton = page.getByRole('button', { name: 'New list', exact: true });
  if ((await newListButton.count()) > 0) {
    await newListButton.first().click();
    await page.getByLabel('List name', { exact: true }).fill('Review List');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }

  // Undated tasks only show up on the All-open view (S2 membership matrix).
  await page.goto(`${APP_URL}#/all`);
  const composer = page.getByPlaceholder('Add task…', { exact: true });
  await expect(composer).toBeVisible();
  for (const title of ['Review alpha task', 'Review beta task', 'Review gamma task']) {
    await composer.fill(title);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
  }
}

test('review probe: axe over populated rows, menus, editor, confirms', async ({ page }) => {
  await seed(page);

  await scanBlocking(page, 'all-open with rows');

  const row = page.getByRole('listitem').filter({ hasText: 'Review alpha task' });
  const menuButton = row.getByRole('button', { name: /^Actions for/ });
  await menuButton.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await scanBlocking(page, 'row menu open');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await row.getByRole('button', { name: 'Review alpha task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit task', exact: true })).toBeVisible();
  await scanBlocking(page, 'task editor dialog');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await menuButton.click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delete task?', exact: true })).toBeVisible();
  await scanBlocking(page, 'delete-task confirm');
  await page.keyboard.press('Escape');

  await page.goto(`${APP_URL}#/lists`);
  await expect(page.getByRole('heading', { name: 'Manage lists', exact: true })).toBeVisible();
  await scanBlocking(page, 'lists manage screen');

  await page
    .getByRole('listitem')
    .filter({ hasText: 'Review List' })
    .getByRole('button', { name: /^Actions for/ })
    .click();
  await page.getByRole('menuitem', { name: 'Delete list', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delete list?', exact: true })).toBeVisible();
  await scanBlocking(page, 'delete-list disposition (S7.2)');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New list', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await scanBlocking(page, 'list create dialog');
  await page.keyboard.press('Escape');

  console.log(
    `SERIOUS/CRITICAL SUMMARY (${String(blockingSeen.length)}):\n${blockingSeen.join('\n=====\n') || 'none'}`,
  );
  expect(blockingSeen, 'serious/critical axe violations across core-UI surfaces').toEqual([]);
});

test('review probe: task-list children (axe `list` rule)', async ({ page }) => {
  await seed(page);
  const info = await page.evaluate(() => {
    const ul = document.querySelector('ul.task-list');
    if (ul === null) return 'no ul';
    return [...ul.children]
      .map(
        (el) =>
          `${el.tagName} class="${el.className}" role=${el.getAttribute('role') ?? '(none)'}`,
      )
      .join('\n');
  });
  console.log(`TASKLIST CHILDREN:\n${info}`);
  const nonLi = await page.evaluate(() => {
    const ul = document.querySelector('ul.task-list');
    if (ul === null) return 'no ul';
    return [...ul.children]
      .filter((el) => el.tagName !== 'LI')
      .map((el) => `${el.tagName}.${el.className}`)
      .join(', ');
  });
  console.log(`NON-LI CHILDREN: ${nonLi || 'none'}`);
  const rects = await page.evaluate(() => {
    const cb = document.querySelector('.task-check');
    const title = document.querySelector('.task-title');
    const r = cb?.getBoundingClientRect();
    const t = title?.getBoundingClientRect();
    return JSON.stringify({
      checkbox: r === undefined ? null : { w: r.width, h: r.height, x: r.x, y: r.y },
      title: t === undefined ? null : { x: t.x, y: t.y, w: t.width },
      gapToTitle: r !== undefined && t !== undefined ? t.x - (r.x + r.width) : null,
    });
  });
  console.log(`CHECKBOX RECT: ${rects}`);
});

test('review probe: focus model facts', async ({ page }) => {
  await seed(page);

  const facts = await page.evaluate(() => {
    const list = document.querySelector('ul.task-list');
    if (list === null) return { error: 'no task list' };
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > li.task-row')];
    const tabbableRows = rows.filter((row) => row.tabIndex === 0);
    const innerTabbable = [...list.querySelectorAll<HTMLElement>('input, button')].filter(
      (el) => el.tabIndex === 0,
    );
    return {
      rowCount: rows.length,
      tabbableRowCount: tabbableRows.length,
      tabbableInnerCount: innerTabbable.length,
      tabbableInner: innerTabbable.map(
        (el) => `${el.tagName.toLowerCase()}.${el.className || '(no class)'}`,
      ),
    };
  });
  console.log(`FACT roving: ${JSON.stringify(facts)}`);

  // Open the row menu from the keyboard and Tab out of it: where does focus land?
  const row = page.getByRole('listitem').filter({ hasText: 'Review beta task' });
  await row.getByRole('button', { name: /^Actions for/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  const menuItems = page.getByRole('menuitem');
  const lastIndex = (await menuItems.count()) - 1;
  await menuItems.nth(lastIndex).focus();
  await page.keyboard.press('Tab');
  const afterTab = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null) return 'none';
    const rowEl = el.closest('li.task-row');
    return `${el.tagName.toLowerCase()} class="${el.className}" tabIndex=${String(el.tabIndex)} insideRow=${rowEl === null ? 'none' : (rowEl.getAttribute('data-task-id') ?? 'row')}`;
  });
  console.log(`FACT menu-Tab lands on: ${afterTab}`);

  // Escape from an inner control must return to the row container (§9.1).
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row.getByRole('button', { name: 'Review beta task', exact: true }).focus();
  await page.keyboard.press('Escape');
  const afterEscape = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null) return 'none';
    return `${el.tagName.toLowerCase()} class="${el.className}" isRow=${String(el.classList.contains('task-row'))}`;
  });
  console.log(`FACT Escape-from-title lands on: ${afterEscape}`);

  // Dialog: focus starts on the title field and returns to the trigger on close.
  await row.getByRole('button', { name: 'Review beta task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit task', exact: true })).toBeVisible();
  const initial = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el === null ? 'none' : `${el.tagName.toLowerCase()} type="${el.getAttribute('type') ?? ''}"`;
  });
  console.log(`FACT editor initial focus: ${initial}`);
  await page.keyboard.press('Escape');
  const returned = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null) return 'none';
    return `${el.tagName.toLowerCase()} text="${(el.textContent ?? '').trim().slice(0, 40)}"`;
  });
  console.log(`FACT focus after editor close: ${returned}`);
});

test('review probe: delete-confirm initial focus is Cancel (S7)', async ({ page }) => {
  await seed(page);
  const row = page.getByRole('listitem').filter({ hasText: 'Review gamma task' });
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Delete task?', exact: true })).toBeVisible();
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el === null ? 'none' : `${el.tagName.toLowerCase()} text="${(el.textContent ?? '').trim()}"`;
  });
  console.log(`FACT delete-confirm initial focus: ${focused}`);
  expect(focused).toContain('Cancel');
});
