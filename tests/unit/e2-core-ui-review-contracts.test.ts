/**
 * E2 core-UI review rework — static design/domain contracts (B2, B4, N4, N6, N7, N9).
 *
 * These pin the findings from `docs/qa/e2-core-ui-review.md` that are properties of the
 * SOURCE (stylesheets, imports, catalogs) rather than of a rendered frame, so they run in
 * `npm test` instead of needing a browser:
 *
 *   B2 `.task-check` must not use the negative-margin hit box axe called `target-size`
 *      (SC 2.5.8) — the 44 px area belongs to a wrapper the row cannot cover.
 *   B4 `.task-row` / `.list-row` need `:hover` and `:active` (§16 item 7 / §10 contract).
 *   N4 the UI reaches storage only through the ADR-003 composition root (`store.ts`).
 *   N6 list rows are found by a dataset scan, never by interpolating a raw id.
 *   N7 toast action/close targets are ≥ 44 × 44 (§5.1 / §16-5).
 *   N9 list rows are named by `list.rowMenu`, a key of their own (en + th).
 *
 * The rendered half of the same findings lives in `tests/component/core-ui-rows.test.tsx`
 * (B1 list semantics, B3 menu Tab, N3 honest save legs) and the browser half in the
 * `docs/qa/e2-core-ui-review-probe.spec.ts` axe/keyboard probe.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const tasksCss = readFileSync('src/styles/tasks.css', 'utf8');
const taskScreen = readFileSync('src/features/tasks/TaskScreen.tsx', 'utf8');
const listsView = readFileSync('src/features/lists/ListsManageView.tsx', 'utf8');
const taskRow = readFileSync('src/features/tasks/TaskRow.tsx', 'utf8');
const store = readFileSync('src/features/tasks/store.ts', 'utf8');
const en = JSON.parse(readFileSync('src/i18n/en.json', 'utf8')) as Record<string, string>;
const th = JSON.parse(readFileSync('src/i18n/th.json', 'utf8')) as Record<string, string>;

interface Rule {
  readonly selectors: string;
  readonly body: string;
}

/** Every `selector { … }` block of a stylesheet (media queries keep their inner rules). */
function rules(css: string): Rule[] {
  // Comments sit in front of many selectors; strip them so `/* … */ .task-check-hit {`
  // still parses as a `.task-check-hit` rule.
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const out: Rule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  for (const match of bare.matchAll(pattern)) {
    out.push({ selectors: (match[1] ?? '').trim(), body: (match[2] ?? '').trim() });
  }
  return out;
}

/** The body of the first block whose selector list contains `selector` ('' when absent). */
function bodyOf(css: string, selector: string): string {
  return (
    rules(css).find((rule) =>
      rule.selectors
        .split(',')
        .map((part) => part.trim())
        .includes(selector),
    )?.body ?? ''
  );
}

describe('B4 — row hover & pressed states (§16 item 7 / §7 S2 / §10 7-state)', () => {
  it('declares :hover and :active for both row kinds on the hover token', () => {
    for (const selector of ['.task-row:hover', '.list-row:hover']) {
      const body = bodyOf(tasksCss, selector);
      expect(body, `${selector} rule`).not.toBe('');
      expect(body).toContain('var(--color-surface-hover)');
    }
    for (const selector of ['.task-row:active', '.list-row:active']) {
      const body = bodyOf(tasksCss, selector);
      expect(body, `${selector} rule`).not.toBe('');
      expect(body).toContain('var(--color-surface-hover)');
    }
    // Hover is an ENHANCEMENT: it stays off touch screens where :hover would stick.
    expect(tasksCss).toContain('@media (hover: hover)');
  });
});

describe('B2 — checkbox hit area (SC 2.5.8 target-size)', () => {
  it('keeps a 24 px visual inside a 44 px wrapper and drops the negative-margin box', () => {
    const check = bodyOf(tasksCss, '.task-check');
    expect(check).not.toBe('');
    expect(check).toContain('width: 24px');
    // The old `margin: -10px` let the row border/title cover ~2 px of the hit area.
    expect(check).not.toMatch(/margin\s*:\s*-/u);
    expect(check).toContain('padding: 0');
    expect(check).not.toMatch(/padding\s*:\s*[1-9]/u);

    const hit = bodyOf(tasksCss, '.task-check-hit');
    expect(hit).not.toBe('');
    expect(hit).toContain('width: var(--touch-min)');
    expect(hit).toContain('height: var(--touch-min)');

    // The wrapper is what the row renders — a class nobody applies pins nothing.
    expect(taskRow).toContain('class="task-check-hit"');
    // …and the input sits inside it in normal flow (no absolute positioning games).
    expect(taskRow.indexOf('task-check-hit')).toBeLessThan(taskRow.indexOf('class="task-check"'));
  });
});

describe('N7 — toast targets (§5.1 / §16-5)', () => {
  it('grows the toast action and close buttons to the 44 px minimum', () => {
    const action = bodyOf(tasksCss, '.toast-action');
    expect(action).toContain('min-height: var(--touch-min)');

    const close = bodyOf(tasksCss, '.toast-close');
    expect(close).toContain('min-width: var(--touch-min)');
    expect(close).toContain('min-height: var(--touch-min)');
  });
});

describe('N4 — domain boundary (ADR-003 composition root)', () => {
  it('keeps src/storage/boot out of the screens and exposes retryBoot() from store.ts', () => {
    expect(taskScreen).not.toMatch(/from '[^']*storage\/boot'/u);
    expect(listsView).not.toMatch(/from '[^']*storage\/boot'/u);
    expect(store).toMatch(/export function retryBoot\(\): void \{/u);
    expect(store).toContain('resetBootSingleton()');
  });
});

describe('N6 — raw-id selectors (security note from the review)', () => {
  it('finds list rows by dataset scan, never by interpolating the id into a selector', () => {
    expect(listsView).not.toContain('[data-list-id="${');
    expect(listsView).toMatch(/function listRowElement\(id: string\)/u);
    expect(listsView).toContain("document.querySelectorAll<HTMLElement>('[data-list-id]')");
  });
});

describe('N9 — list row menu key (§5.8 i18n discipline)', () => {
  it('has a `list.rowMenu` key in both catalogs, distinct from `task.rowMenu` in Thai', () => {
    expect(en['list.rowMenu']).toBeTruthy();
    expect(th['list.rowMenu']).toBeTruthy();
    expect(th['task.rowMenu']).toBeTruthy();
    // English happens to share the copy; Thai names the LIST explicitly, which is the
    // observable difference that proves the two keys are not the same entry.
    expect(th['list.rowMenu']).not.toBe(th['task.rowMenu']);
    expect(en['list.rowMenu']).toContain('{title}');
    expect(th['list.rowMenu']).toContain('{title}');
  });

  it('is the key the lists screen actually calls', () => {
    expect(listsView).toContain("t('list.rowMenu'");
    expect(listsView).not.toContain("t('task.rowMenu'");
  });
});
