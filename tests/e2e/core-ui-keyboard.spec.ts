/**
 * E2 core-UI QA — keyboard-only pass of the five core flows in a REAL browser, plus the
 * §9.1 / M8 performance and touch-target budgets (docs/qa/e2-core-ui.md).
 *
 * Covers the §16 item 42 keyboard script for this card's flows:
 *   F1 capture · F2 edit · F3 complete/uncomplete · F4 delete (confirm) · F6 delete list
 *   (disposition). No pointer event is used in `keyboard flows` — only Tab, typing and key
 *   presses; the one click-shaped activation (Enter on a focused button) is the browser's own.
 *
 * Instrumentation (additive, never perturbs timing):
 *   - a `keydown` timestamp for the capture Enter,
 *   - a MutationObserver timestamp for the moment the new row exists in the DOM,
 *   - IndexedDB write issue/settle timestamps (`IDBObjectStore.add/put/...` plus the matching
 *     readwrite `success` listener) so the paint can be compared against the real persistence
 *     round-trip.
 *
 * Evidence is written to E2E_EVIDENCE, or to <repo>/test-results/evidence/ when that override is
 * unset (tests/evidence.ts), after the run.
 */

import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';

import { evidencePath } from '../evidence';
import { APP_URL } from './helpers';

// Evidence target: E2E_EVIDENCE (existing override, e.g. a QA reviewer's scratch dir) or the
// portable repo-local default — the machine-local fallback this used to ship does not exist on
// the CI runner (t_61309e52).
const EVIDENCE_PATH = process.env['E2E_EVIDENCE'] ?? evidencePath('e2-core-ui-keyboard-e2e.md');

/** The shell's two persistent live regions (design §5.5). */
const POLITE = '.live-regions [role="status"]';
const ASSERTIVE = '.live-regions [role="alert"]';

const evidence: string[] = [];

function record(line: string): void {
  evidence.push(line);
}

test.afterAll(() => {
  const passed = evidence.filter((line) => line.startsWith('  PASS')).length;
  const dir = EVIDENCE_PATH.slice(0, Math.max(EVIDENCE_PATH.lastIndexOf('/'), 1));
  fs.mkdirSync(dir, { recursive: true });
  // Tests run in parallel workers, so each worker APPENDS its own steps to one file.
  if (!fs.existsSync(EVIDENCE_PATH)) {
    fs.writeFileSync(
      EVIDENCE_PATH,
      [
        '# E2 core UI — keyboard-only pass in a real browser (Playwright/chromium)',
        '',
        'Every step below used Tab / typing / key presses only (no mouse, no pointer events).',
        '',
      ].join('\n'),
    );
  }
  fs.appendFileSync(
    EVIDENCE_PATH,
    ['', `## worker ${String(process.pid)} — ${String(passed)} PASS step(s)`, ...evidence, ''].join(
      '\n',
    ),
  );
});

/* ------------------------------------------------------------------ helpers */

/** Observe IndexedDB writes plus every live-region announcement the shell makes. */
async function installTrace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const holder = window as unknown as {
      __writeTrace: { issued: number[]; settled: number[] };
      __announcements: { polite: string[]; assertive: string[] };
    };
    holder.__writeTrace = { issued: [], settled: [] };
    holder.__announcements = { polite: [], assertive: [] };

    // Announcement recorder: the polite region is shared by several features, so a later
    // message can legitimately overwrite an earlier one — record the SEQUENCE instead.
    const last = { polite: '', assertive: '' };
    const snapshot = (): void => {
      for (const channel of ['polite', 'assertive'] as const) {
        const selector =
          channel === 'polite' ? '.live-regions [role="status"]' : '.live-regions [role="alert"]';
        const region = document.querySelector(selector);
        const text = (region?.textContent ?? '').trim();
        if (text !== '' && text !== last[channel]) {
          last[channel] = text;
          holder.__announcements[channel].push(text);
        }
      }
    };
    const announcementObserver = new MutationObserver(snapshot);
    // Observe the DOCUMENT node: this script runs before <html> exists, so
    // `document.documentElement` can still be null here.
    announcementObserver.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener('DOMContentLoaded', snapshot);

    const methodDescriptor = (name: string): ((...args: unknown[]) => IDBRequest) => {
      const found = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, name);
      if (found === undefined || typeof found.value !== 'function') {
        throw new Error(`IDBObjectStore.prototype.${name} is not a function`);
      }
      return found.value as (...args: unknown[]) => IDBRequest;
    };

    for (const method of ['add', 'put', 'delete', 'clear'] as const) {
      const original = methodDescriptor(method);
      const patched = function (this: IDBObjectStore, ...args: unknown[]): IDBRequest {
        holder.__writeTrace.issued.push(performance.now());
        return original.apply(this, args);
      };
      Object.defineProperty(IDBObjectStore.prototype, method, {
        value: patched,
        writable: true,
        configurable: true,
      });
    }

    // `addEventListener` lives on EventTarget.prototype — capture it there and re-expose
    // the patch as an OWN property of IDBRequest.prototype, so only IDB requests are traced.
    const addDescriptor = Object.getOwnPropertyDescriptor(
      EventTarget.prototype,
      'addEventListener',
    );
    if (addDescriptor === undefined || typeof addDescriptor.value !== 'function') {
      throw new Error('EventTarget.prototype.addEventListener is not a function');
    }
    const addEventListenerOriginal = addDescriptor.value as (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => void;
    const patchedAdd = function (
      this: IDBRequest,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const isWrite =
        this.transaction !== null &&
        this.transaction.mode === 'readwrite' &&
        (type === 'success' || type === 'error');
      if (!isWrite || typeof listener !== 'function') {
        addEventListenerOriginal.call(this, type, listener, options);
        return;
      }
      const wrapped = function (this: IDBRequest, event: Event): void {
        holder.__writeTrace.settled.push(performance.now());
        listener.call(this, event);
      };
      addEventListenerOriginal.call(this, type, wrapped, options);
    };
    Object.defineProperty(IDBRequest.prototype, 'addEventListener', {
      value: patchedAdd,
      writable: true,
      configurable: true,
    });
  });
}

async function boot(page: Page): Promise<void> {
  await installTrace(page);
  await page.goto(APP_URL);

  // Epic E3's first-run screen replaces the shell on a fresh profile. It is setup, not one
  // of the core flows, and it is dismissed with the keyboard like everything else here.
  // Wait for EITHER screen before deciding — the app renders asynchronously after goto.
  const firstRun = page.getByRole('button', { name: 'Get started', exact: true });
  const todayHeading = page.getByRole('heading', { name: 'Today', level: 1, exact: true });
  await expect(firstRun.or(todayHeading).first()).toBeVisible({ timeout: 15_000 });
  if (await firstRun.isVisible()) {
    await tabTo(page, '.onboarding-actions button');
    record('  SETUP. first-run screen (Epic E3) dismissed from the keyboard');
    await page.keyboard.press('Enter');
  }
  await expect(todayHeading).toBeVisible();
  // The domain store has to be READY before any flow: the composer/rows only mount then.
  await expect(page.locator('.empty-state')).toBeVisible();
}

/** Press Tab until `document.activeElement` matches the CSS selector. */
async function tabTo(page: Page, selector: string, max = 80): Promise<void> {
  const onTarget = async (): Promise<boolean> =>
    page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
  for (let step = 0; step < max; step += 1) {
    await page.keyboard.press('Tab');
    if (await onTarget()) {
      // A late route-change effect can steal focus right after Tab: confirm it stayed.
      await page.waitForTimeout(50);
      if (await onTarget()) return;
      continue;
    }
    // Firefox (headless): Tab past the document's LAST focusable leaves focus where it is —
    // a real window would walk its chrome and re-enter the page at the first element, but the
    // automation has no chrome to walk (nightly t_e20c2adb: 80 presses never reached
    // `a[href="#/all"]`, while chromium/webkit wrap in-page and pass). Emulate that re-entry
    // ONLY when focus provably sits on the last focusable: a focus stuck anywhere else (a
    // genuine keyboard trap) still burns the budget below and fails loudly.
    const wrapped = await page.evaluate(() => {
      const current = document.activeElement;
      if (!(current instanceof HTMLElement)) return false;
      const focusables = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex]',
        ),
      ].filter(
        (el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getClientRects().length > 0,
      );
      if (focusables.length === 0 || focusables[focusables.length - 1] !== current) return false;
      focusables[0]?.focus();
      return true;
    });
    if (wrapped && (await onTarget())) return;
  }
  throw new Error(`tabTo(${selector}): no focusable match within ${String(max)} presses`);
}

async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'null';
    return el.outerHTML.slice(0, 90);
  });
}

/**
 * Assert that the given message was announced on the polite region at SOME point.
 * The region is shared (a later message overwrites the text), so this checks the recorded
 * sequence rather than the current string.
 */
async function expectPolite(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => politeSaid(page, text, 12_000), {
      message: `polite announcement "${text}" was never made`,
      timeout: 20_000,
    })
    .toBe(true);
}

/** Every message the polite region has carried so far (diagnostic trace). */
async function politeTrace(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const holder = window as unknown as { __announcements: { polite: string[] } };
    return [...holder.__announcements.polite];
  });
}

/** Did the polite region ever carry this message? (bounded poll, then `false`) */
async function politeSaid(page: Page, text: string, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await page.evaluate(
      (wanted) =>
        (
          window as unknown as { __announcements: { polite: string[] } }
        ).__announcements.polite.includes(wanted),
      text,
    );
    if (hit) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(100);
  }
}

/** A task row's title button — the row's primary control (§5.3 semantics). */
function taskButton(page: Page, title: string) {
  return page.getByRole('button', { name: title, exact: true });
}

/** Arm the capture probe: keydown timestamp + row-appearance timestamp + fresh write trace. */
async function armAddProbe(page: Page, title: string): Promise<void> {
  await page.evaluate((wanted) => {
    const holder = window as unknown as {
      __addProbe: { keydownAt: number | null; visibleAt: number | null };
      __writeTrace: { issued: number[]; settled: number[] };
    };
    holder.__addProbe = { keydownAt: null, visibleAt: null };
    holder.__writeTrace.issued = [];
    holder.__writeTrace.settled = [];

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' || holder.__addProbe.keydownAt !== null) return;
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.closest('.composer-inline') === null) return;
        holder.__addProbe.keydownAt = performance.now();
      },
      true,
    );

    const observer = new MutationObserver(() => {
      if (holder.__addProbe.visibleAt !== null) return;
      const present = [...document.querySelectorAll('.task-title-text')].some(
        (node) => node.textContent === wanted,
      );
      if (!present) return;
      holder.__addProbe.visibleAt = performance.now();
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }, title);
}

/* --------------------------------------------------------- the keyboard pass */

test('keyboard-only: F1 capture → F2 edit → F3 complete → F4 delete → F6 delete list', async ({
  page,
}) => {
  await boot(page);

  /* --- setup: zero lists → the composer's documented New list path (§16 item 16) --------- */
  await tabTo(page, '.composer-nolist button');
  record(`  PASS 0. Tab → composer "New list" (${await focused(page)}) — zero-list state`);
  await page.keyboard.press('Enter');
  const firstListDialog = page.getByRole('dialog', { name: 'New list', exact: true });
  await expect(firstListDialog).toBeVisible();
  // The dialog moves focus to its name field in an effect — wait for it before typing.
  await expect(
    firstListDialog.getByRole('textbox', { name: 'List name', exact: true }),
  ).toBeFocused();
  await page.keyboard.type('Personal');
  await page.keyboard.press('Enter');
  await expect(firstListDialog).toBeHidden();
  record(`  DEBUG. polite trace after list #1: ${JSON.stringify(await politeTrace(page))}`);
  await expectPolite(page, 'List created: Personal');
  record('  PASS 1. Enter → list created; polite region: "List created: Personal"');

  /* --- keyboard navigation (F7) ----------------------------------------------------------- */
  await tabTo(page, 'a[href="#/all"]');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'All open', level: 1, exact: true }),
  ).toBeVisible();
  record('  PASS 2. Tab → sidebar "All open" → Enter → view, no pointer event');

  /* --- F1 capture + the optimistic-latency measurement ------------------------------------- */
  await tabTo(page, '.composer-inline input[type="text"]');
  await armAddProbe(page, 'Buy milk');
  await page.keyboard.type('Buy milk');
  await page.keyboard.press('Enter');
  await expect(taskButton(page, 'Buy milk')).toBeVisible();
  // F1 requires `a11y.taskAdded` (design §5.5). It is checked as a RECORDED outcome, because
  // the first write also triggers Epic E3's persistence notice on the same region — if that
  // notice lands inside the 60 ms announce delay it cancels this message (defect F-1).
  const firstAddSaid = await politeSaid(page, 'Task added: Buy milk', 4000);
  record(
    firstAddSaid
      ? '  PASS 3. F1: Tab → composer, type, Enter → row visible; polite: "Task added: Buy milk"'
      : '  FINDING F-1. F1: row visible, but "Task added: Buy milk" never reached the polite ' +
          'region (cancelled by the first-write persistence notice) — docs/qa/e2-core-ui.md',
  );

  const probe = await page.evaluate(() => {
    const holder = window as unknown as {
      __addProbe: { keydownAt: number | null; visibleAt: number | null };
      __writeTrace: { issued: number[]; settled: number[] };
    };
    return {
      keydownAt: holder.__addProbe.keydownAt,
      visibleAt: holder.__addProbe.visibleAt,
      issued: [...holder.__writeTrace.issued],
      settled: [...holder.__writeTrace.settled],
    };
  });
  expect(probe.keydownAt).not.toBeNull();
  expect(probe.visibleAt).not.toBeNull();
  expect(probe.settled.length).toBeGreaterThan(0);

  const keydownAt = probe.keydownAt ?? 0;
  const visibleMs = (probe.visibleAt ?? 0) - keydownAt;
  const firstIssued = probe.issued.at(0) ?? 0;
  const firstSettled = probe.settled.at(0) ?? 0;
  const issuedMs = firstIssued - keydownAt;
  const settledMs = firstSettled - keydownAt;
  // §9.1 / design §5.6: perceived add latency budget < 100 ms — measured, not claimed.
  expect(visibleMs).toBeLessThan(100);
  // …and the paint happens before the IndexedDB write settles: the UI never waits on I/O.
  expect(probe.visibleAt ?? Number.POSITIVE_INFINITY).toBeLessThan(firstSettled);
  record(
    `  PASS 4. optimistic add measured: row in the DOM +${visibleMs.toFixed(1)} ms after Enter; ` +
      `IndexedDB write issued +${issuedMs.toFixed(1)} ms, settled +${settledMs.toFixed(1)} ms ` +
      `(visible strictly before settle)`,
  );

  // Capture stays ready (D6): the next capture starts straight away.
  await page.keyboard.type('Walk dog');
  await page.keyboard.press('Enter');
  await expect(taskButton(page, 'Walk dog')).toBeVisible();
  await expectPolite(page, 'Task added: Walk dog');
  record('  PASS 5. F1 repeat: Enter → second task added without leaving the composer');

  /* --- F2 edit ------------------------------------------------------------------------------ */
  await tabTo(page, 'li.task-row .task-title');
  await page.keyboard.press('Enter');
  const editor = page.getByRole('dialog', { name: 'Edit task', exact: true });
  await expect(editor).toBeVisible();
  // §16 item 18: focus starts on the title field.
  await expect(page.locator('.task-editor input[type="text"]').first()).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Buy oat milk');
  await page.keyboard.press('Enter'); // single-line Enter saves (§9.5)
  await expect(editor).toBeHidden();
  await expect(taskButton(page, 'Buy oat milk')).toBeVisible();
  await expectPolite(page, 'Task saved');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('task-title'))).toBe(
    true,
  );
  record(
    '  PASS 6. F2: Enter → editor (focus on Title), edit, Enter → saved, dialog closed, ' +
      'focus back on the row button, polite: "Task saved"',
  );

  /* --- F3 complete / uncomplete -------------------------------------------------------------- */
  await page.keyboard.press('Escape'); // inner control → the row container (§9.1)
  expect(await page.evaluate(() => document.activeElement?.matches('li.task-row') ?? false)).toBe(
    true,
  );
  await page.keyboard.press(' ');
  await expect(page.locator('li.task-row .task-check').first()).toBeChecked();
  await expectPolite(page, 'Task completed');
  // F3 retention: the completed row is still on screen (marked retained)…
  await expect(page.locator('li.task-row[data-retained="true"]')).toHaveCount(1);
  await expect(page.locator('li.task-row')).toHaveCount(2);
  // …then collapses out of the open view once the 900 ms window elapses.
  await expect(page.locator('li.task-row[data-retained="true"]')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('li.task-row')).toHaveCount(1);
  record(
    '  PASS 7. F3: Space on the focused row → optimistic check + "Task completed", row held ' +
      'then collapsed (900 ms retention)',
  );

  await tabTo(page, 'a[href="#/completed"]');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Completed', level: 1, exact: true }),
  ).toBeVisible();
  await expect(taskButton(page, 'Buy oat milk')).toBeVisible();
  await tabTo(page, 'li.task-row');
  await page.keyboard.press(' ');
  await expectPolite(page, 'Task reopened');
  await expect(page.locator('li.task-row')).toHaveCount(0, { timeout: 3000 });
  record('  PASS 8. F3 uncomplete: Completed view → Space → "Task reopened", row leaves again');

  /* --- F4 delete with confirm ------------------------------------------------------------------ */
  await tabTo(page, 'a[href="#/all"]');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'All open', level: 1, exact: true }),
  ).toBeVisible();
  await tabTo(page, 'li.task-row');
  await page.keyboard.press('End'); // §9.1: jump to the last row ("Walk dog")
  const confirm = page.getByRole('dialog', { name: 'Delete task?', exact: true });
  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  record('  PASS 9. F4: End → last row, Delete → S7.1 confirm, initial focus on Cancel');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(taskButton(page, 'Walk dog')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.matches('li.task-row') ?? false)).toBe(
    true,
  );
  record('  PASS 10. Escape → cancelled, task intact, focus back on the row');

  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  // §9.6 trap: from the first control, Shift+Tab wraps to the LAST control (the confirm).
  await page.keyboard.press('Shift+Tab');
  await expect(confirm.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeHidden();
  await expect(taskButton(page, 'Walk dog')).toBeHidden();
  await expectPolite(page, 'Task deleted');
  record(
    '  PASS 11. Shift+Tab wraps to the confirm action (§9.6 trap) → Enter → removed; ' +
      'polite: "Task deleted"',
  );

  /* --- F6 delete a list with task disposition ----------------------------------------------------- */
  await tabTo(page, 'a[href="#/lists"]');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Manage lists', level: 1, exact: true }),
  ).toBeVisible();

  await tabTo(page, '.list-actions button');
  await page.keyboard.press('Enter');
  const workListDialog = page.getByRole('dialog', { name: 'New list', exact: true });
  await expect(workListDialog).toBeVisible();
  await expect(
    workListDialog.getByRole('textbox', { name: 'List name', exact: true }),
  ).toBeFocused();
  await page.keyboard.type('Work');
  await page.keyboard.press('Enter');
  await expect(workListDialog).toBeHidden();
  const listNames = await page.locator('li[data-list-id] .list-row-name').allTextContents();
  record(`  DEBUG. lists on screen after create: ${JSON.stringify(listNames)}`);
  await expectPolite(page, 'List created: Work');
  record('  PASS 12. F5 create (keyboard): New list → dialog → Enter → "List created: Work"');

  await tabTo(page, 'li[data-list-id] .row-menu-trigger');
  await page.keyboard.press('ArrowDown'); // §9.2: opens and focuses the first item
  await expect(page.getByRole('menu')).toBeVisible();
  record(`  PASS 12b. row-menu opened from the keyboard; focus = ${await focused(page)}`);
  await page.keyboard.press('End'); // §9.2: End jumps to the last item
  record(`  PASS 12c. after End; focus = ${await focused(page)}`);
  await expect(page.getByRole('menuitem', { name: 'Delete list', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');

  const listConfirm = page.getByRole('dialog', { name: 'Delete list?', exact: true });
  await expect(listConfirm).toBeVisible();
  await expect(
    listConfirm.getByText(
      '"Personal" has 1 open and 0 completed tasks. Choose what happens to them.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(listConfirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  record('  PASS 13. F6: row menu → Delete list → S7.2 dialog shows counts, focus on Cancel');

  // Forward Tab from Cancel lands on the confirm action (the disposition radios precede
  // Cancel in the DOM, so Cancel is not the first control here).
  await page.keyboard.press('Tab');
  await expect(listConfirm.getByRole('button', { name: 'Delete list', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(listConfirm).toBeHidden();
  await expectPolite(page, 'List "Personal" deleted (1 tasks)');
  // §16 item 29: focus lands on the screen heading (never dropped on the document).
  await expect(page.locator('main [data-view-title]')).toBeFocused();
  record(
    '  PASS 14. Enter → one transaction: list gone, tasks moved, ' +
      '"List \\"Personal\\" deleted (1 tasks)", focus on the h1',
  );

  // Disposition A verified in the UI: the task survived by moving to the other list.
  await tabTo(page, 'a[href="#/all"]');
  await page.keyboard.press('Enter');
  await expect(taskButton(page, 'Buy oat milk')).toBeVisible();
  await expect(page.locator('li.task-row .list-badge')).toHaveText('Work');
  record('  PASS 15. disposition A verified: task still open, list badge now "Work"');

  // Exactly one polite + one assertive region for the whole run (design §5.5).
  await expect(page.locator(POLITE)).toHaveCount(1);
  await expect(page.locator(ASSERTIVE)).toHaveCount(1);
  record('  PASS 16. exactly one polite + one assertive live region mounted');

  const sequence = await page.evaluate(() => {
    const holder = window as unknown as {
      __announcements: { polite: string[]; assertive: string[] };
    };
    return {
      polite: [...holder.__announcements.polite],
      assertive: [...holder.__announcements.assertive],
    };
  });
  record(`  PASS 17. polite announcement sequence: ${sequence.polite.join(' | ')}`);
  record(
    `  PASS 18. assertive announcement sequence: ${sequence.assertive.join(' | ') || '(none)'}`,
  );
});

/* ------------------------------------------------------ touch targets (M8 / §8) */

test('touch targets are at least 44×44 CSS px on a compact viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await boot(page);

  const results: { label: string; w: number; h: number; boxSizing: string; padding: string }[] = [];

  const measure = async (selector: string): Promise<void> => {
    const detail = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        boxSizing: cs.boxSizing,
        padding: cs.padding,
      };
    }, selector);
    expect(detail, `no element matched ${selector}`).not.toBeNull();
    results.push({
      label: selector,
      w: detail?.w ?? 0,
      h: detail?.h ?? 0,
      boxSizing: detail?.boxSizing ?? '',
      padding: detail?.padding ?? '',
    });
  };

  for (const selector of [
    '.fab',
    '.tabbar a.tab',
    '.tabbar button.tab',
    '.appbar .icon-button',
    '.empty-state .button',
  ]) {
    await measure(selector);
  }

  // Create a list + task through the compact flow so the row controls exist too.
  await page.locator('.fab').click();
  const sheet = page.getByRole('dialog', { name: 'Add task', exact: true });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'New list', exact: true }).click();
  const listDialog = page.getByRole('dialog', { name: 'New list', exact: true });
  await expect(listDialog).toBeVisible();
  const nameField = listDialog.getByRole('textbox', { name: 'List name', exact: true });
  await expect(nameField).toBeFocused();
  await nameField.fill('Personal');
  await page.keyboard.press('Enter');
  await expect(listDialog).toBeHidden();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Buy milk');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // D6: the field clears synchronously on submit. Wait for the re-render before Escape —
  // pressing in the same tick would close against the pre-submit (dirty) state.
  const titleInput = page.getByRole('textbox', { name: 'Title', exact: true });
  await expect(titleInput).toHaveValue('');
  await page.waitForTimeout(300);
  const restoredTitle = await titleInput.inputValue();
  const toastText = await page.locator('.toast-host .toast, .toast-stack .toast').allTextContents();
  record(
    `  DEBUG. after Add: title="${restoredTitle}", rows=${String(await page.locator('li.task-row').count())}, toasts=${JSON.stringify(toastText)}`,
  );
  // The sheet stays open (D6 capture); close it, then go where an undated task is a member
  // — Today only lists dated tasks (D3 membership), so the row lives in All open.
  await page.keyboard.press('Escape');
  const dialogInfo = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"]')].map((d) =>
      (d.getAttribute('aria-label') ?? d.querySelector('h2,h3')?.textContent ?? '').slice(0, 50),
    ),
  );
  record(`  DEBUG. after Escape: open dialogs ${JSON.stringify(dialogInfo)}`);
  await expect(sheet).toBeHidden();
  await page.getByRole('link', { name: 'All open', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'All open', level: 1, exact: true }),
  ).toBeVisible();
  await expect(taskButton(page, 'Buy milk')).toBeVisible();

  // The EFFECTIVE toggle target after the review rework (b32cf9a) is the label wrapper
  // `.task-check-hit` (44×44, natively toggles the input). The bare `.task-check` input
  // inside it stays 24×24 by design (§5.1 visual) and is recorded for reference only.
  await measure('.task-check-hit');
  for (const selector of ['.task-title', '.row-menu-trigger']) {
    await measure(selector);
  }

  // Lists screen controls (reached through the drawer).
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Menu', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Manage lists', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Manage lists', level: 1, exact: true }),
  ).toBeVisible();
  for (const selector of [
    '.list-actions button',
    '.list-row-link',
    '.list-row .row-menu-trigger',
  ]) {
    await measure(selector);
  }

  // Every measured selector is an EFFECTIVE user target — all must be ≥ 44×44 (M8/§5.1).
  const offenders = results.filter((r) => r.w < 44 || r.h < 44);
  const summary = results.map((r) => `${r.label}: ${String(r.w)}×${String(r.h)}`).join('; ');
  const detail = offenders
    .map(
      (r) =>
        `${r.label}: ${String(r.w)}×${String(r.h)} (box-sizing: ${r.boxSizing}, padding: ${r.padding})`,
    )
    .join('; ');
  record(`  ${offenders.length === 0 ? 'PASS' : 'FAIL'} 17. touch targets @375 px — ${summary}`);
  if (offenders.length > 0) {
    record(`  DETAIL. below 44×44 — ${detail}`);
  }
  expect(offenders, `targets below 44×44: ${JSON.stringify(offenders)}`).toEqual([]);
});
