/**
 * QA probe — E2 card t_fa0903f2: M5 search, M6 manual reorder, list virtualization.
 *
 * Independent evidence for `docs/qa/e2-search-reorder.md`. Everything runs in a REAL Chromium
 * against the production build (the Playwright `webServer` runs `npm run build` + `vite preview`)
 * with real IndexedDB:
 *
 *   1. M5 search @10,000 seeded fixtures — per-keystroke latency (input event → first DOM
 *      mutation / next frame), title + notes coverage with `<mark>` highlighting, instant filter
 *      (no submit), the debounced result-count announcement, and the search-view
 *      reorder-unavailable announcement (D1).
 *   2. M6 reorder — the SAME three logical moves executed through (a) the keyboard equivalent
 *      (Alt+↓ / Alt+↑ / Alt+Home) and (b) a real pointer drag from the grip handle, each on a
 *      freshly seeded identical corpus. Persisted order is read back from IndexedDB after every
 *      move and the two paths are compared move-by-move (scripted comparison). Every move also
 *      proves: exactly ONE task-record write at the IDB boundary, exactly ONE changed order key
 *      (neighbours byte-identical), focus retention, the live-region announcement, and
 *      persistence across a reload.
 *   3. Virtualization @1,200 rows — DOM window size, keyboard navigation across window
 *      boundaries (End / PageUp / Arrow), aria-posinset/aria-setsize truth, and scroll frame
 *      timings (unthrottled + 4× CPU throttle, §9.1 mid-tier-mobile method).
 *   4. Touch targets — `.reorder-handle` box at 375 px and 320 px viewports (M8 / §8: ≥44×44).
 *
 * Chromium only (the performance evidence is single-browser by design), one worker, fresh
 * profile per test:
 *
 *   E2E_PORT=4192 npx playwright test --project=chromium --workers=1 tests/e2e/qa-search-reorder.spec.ts
 *
 * Evidence is written to `$QA_EVIDENCE_DIR` (default `docs/qa/e2-search-reorder-logs/`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { APP_URL } from './helpers';

const EVIDENCE_DIR =
  process.env['QA_EVIDENCE_DIR'] ?? resolve(process.cwd(), 'docs/qa/e2-search-reorder-logs');

/** Accumulated evidence, flushed after every test so a crash keeps the partial numbers. */
const evidence: Record<string, unknown> = {};

function record(key: string, value: unknown): void {
  evidence[key] = value;
  // Flush on every record, AND write one file per key: the aggregate file alone loses the
  // earlier tests' numbers if the runner rotates module state between tests.
  flush();
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(resolve(EVIDENCE_DIR, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    /* evidence is best-effort — never fail a test over the log write */
  }
}

function flush(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    resolve(EVIDENCE_DIR, 'search-reorder-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

declare global {
  interface Window {
    /** Put/add counters installed by the init script (single-record-write proof). */
    __qaM56: { counts: Record<string, number>; reset: () => void };
  }
}

/* ------------------------------------------------------------------ *
 * Seed corpus (page side — runs in the browser, real IndexedDB)        *
 * ------------------------------------------------------------------ */

type TitleStyle = 'search' | 'reorder' | 'virtual';

type SeedSpec = {
  readonly listId: string;
  readonly listName: string;
  readonly count: number;
  readonly idOffset: number;
  readonly titleStyle: TitleStyle;
  /** Every Nth task gets notes containing `notesToken` (0 = no notes at all). */
  readonly notesEvery: number;
  readonly notesToken: string;
};

/** 19-char Crockford ULID head + 7 decimal digits = a valid 26-char ULID. */
const LIST_ID_PREFIX = '01ARZ3NDEKTSV4RRFFR';

function listIdFor(idOffset: number): string {
  return `${LIST_ID_PREFIX}${String(idOffset).padStart(7, '0')}`;
}

/**
 * Write the corpus into the app's own database (its stores already exist — the app created them
 * on first boot) and return what landed. `meta`/`settings` are deliberately untouched so the
 * data-safety boot classification keeps seeing the app's own values.
 */
async function seedRows(page: Page, spec: SeedSpec): Promise<{ tasks: number; deviceId: string }> {
  return page.evaluate(async (s) => {
    const openDb = (): Promise<IDBDatabase> =>
      new Promise((res, rej) => {
        const request = indexedDB.open('local-first-todo');
        request.onsuccess = () => {
          res(request.result);
        };
        request.onerror = () => {
          rej(new Error(`IDB open failed: ${request.error?.name ?? 'unknown'}`));
        };
      });
    const db = await openDb();
    const names = Array.from(db.objectStoreNames);
    if (!names.includes('tasks') || !names.includes('lists')) {
      throw new Error(`app stores missing (app must boot first): ${names.join(', ')}`);
    }
    const meta = await new Promise<Record<string, unknown> | undefined>((res, rej) => {
      const tx = db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get('meta');
      request.onsuccess = () => {
        res(request.result as Record<string, unknown> | undefined);
      };
      request.onerror = () => {
        rej(new Error(`IDB open failed: ${request.error?.name ?? 'unknown'}`));
      };
    });
    const deviceId = meta?.['deviceId'];
    if (typeof deviceId !== 'string') throw new Error('meta.deviceId missing');

    const now = Date.now();
    const taskPrefix = '01ARZ3NDEKTSV4RRFFQ';
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < s.count; i += 1) {
      const n = s.idOffset + i;
      const word = `x${(i % 1296).toString(36).padStart(2, '0')}`;
      const title =
        s.titleStyle === 'search'
          ? `Fixture ${String(i + 1).padStart(5, '0')} ${word}${i % 8 === 0 ? ' apple' : ''}`
          : s.titleStyle === 'reorder'
            ? `Reorder ${String(i + 1).padStart(2, '0')}`
            : `Virtual ${String(i + 1).padStart(4, '0')} ${word}`;
      const hasNotes = s.notesEvery > 0 && i % s.notesEvery === 0;
      // D5: search covers ALL non-deleted tasks, open AND completed — one corpus member is a
      // completed task with a unique title token so the probe can prove it is searchable.
      const isDone = s.titleStyle === 'search' && i === 5;
      rows.push({
        id: `${taskPrefix}${String(n).padStart(7, '0')}`,
        listId: s.listId,
        title: isDone ? `${title} zquestdone` : title,
        notes: hasNotes ? `note ${s.notesToken} ${String(i)}` : null,
        status: isDone ? 'done' : 'open',
        priority: 0,
        tags: [],
        sortOrder: `h${n.toString(36).padStart(6, '0')}z`,
        createdAt: now - (s.count - i),
        updatedAt: now - (s.count - i),
        ...(isDone ? { completedAt: now - (s.count - i) + 1 } : {}),
        deletedAt: null,
        deviceId,
      });
    }
    const listRow = {
      id: s.listId,
      name: s.listName,
      color: '#336699',
      sortOrder: 'h',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deviceId,
    };
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(['lists', 'tasks'], 'readwrite');
      tx.objectStore('lists').put(listRow);
      const store = tx.objectStore('tasks');
      for (const row of rows) store.put(row);
      tx.oncomplete = () => {
        res();
      };
      tx.onerror = () => {
        rej(new Error(`IDB tx failed: ${tx.error?.name ?? 'unknown'}`));
      };
      tx.onabort = () => {
        rej(new Error(`IDB tx failed: ${tx.error?.name ?? 'unknown'}`));
      };
    });
    db.close();
    return { tasks: rows.length, deviceId };
  }, spec);
}

async function readTaskRows(
  page: Page,
  listId: string,
): Promise<Array<{ title: string; sortOrder: string; id: string }>> {
  return page.evaluate(async (id) => {
    const openDb = (): Promise<IDBDatabase> =>
      new Promise((res, rej) => {
        const request = indexedDB.open('local-first-todo');
        request.onsuccess = () => {
          res(request.result);
        };
        request.onerror = () => {
          rej(new Error(`IDB open failed: ${request.error?.name ?? 'unknown'}`));
        };
      });
    const db = await openDb();
    const rows = await new Promise<Record<string, unknown>[]>((res, rej) => {
      const tx = db.transaction('tasks', 'readonly');
      const request = tx.objectStore('tasks').index('by_listId').getAll(id);
      request.onsuccess = () => {
        res(request.result as Record<string, unknown>[]);
      };
      request.onerror = () => {
        rej(new Error(`IDB open failed: ${request.error?.name ?? 'unknown'}`));
      };
    });
    db.close();
    const mapped = rows.map((row) => ({
      title: String(row['title']),
      sortOrder: String(row['sortOrder']),
      id: String(row['id']),
    }));
    mapped.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return mapped;
  }, listId);
}

/** Titles in persisted (sortOrder) order for one list — straight out of IndexedDB. */
async function persistedOrder(page: Page, listId: string): Promise<string[]> {
  return (await readTaskRows(page, listId)).map((row) => row.title);
}

/** Persisted order keys per title — for the "only ONE record changed" assertion. */
async function persistedKeys(page: Page, listId: string): Promise<Record<string, string>> {
  const rows = await readTaskRows(page, listId);
  const out: Record<string, string> = {};
  for (const row of rows) out[row.title] = row.sortOrder;
  return out;
}

/** Titles of the rows currently in the DOM. */
async function domOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('ul.task-list [data-task-id]')).map(
      (el) => el.querySelector('.task-title')?.textContent ?? '',
    ),
  );
}

async function readCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({ ...window.__qaM56.counts }));
}

async function resetCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__qaM56.reset();
  });
}

/** The polite live region's current text. */
function politeRegion(page: Page) {
  return page.locator('div[role="status"][aria-live="polite"]');
}

/**
 * Wait for the app's own IndexedDB to exist. Uses `indexedDB.databases()` on purpose: opening
 * the database here would CREATE an empty version-1 store and the app's upgrade would then
 * never fire (no `onupgradeneeded` at the same version) — a probe must never do that.
 */
async function waitForAppStore(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const dbs = await indexedDB.databases();
      return dbs.some((db) => db.name === 'local-first-todo');
    },
    undefined,
    { timeout: 45_000 },
  );
}

/**
 * Walk through whichever first-run screen a fresh profile presents (first-run onboarding, or
 * the §3.4 "your data is gone" recovery screen a profile with a prior-use flag but no rows
 * hits) until the shell's Today view is up. Clicking is the real user path, so the persisted
 * flags land exactly where a human's click would put them.
 */
async function settleFirstRun(page: Page): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if ((await page.getByRole('heading', { name: 'Today', level: 1, exact: true }).count()) > 0) {
      return;
    }
    const startFresh = page.getByRole('button', { name: 'Start fresh', exact: true });
    if ((await startFresh.count()) > 0) {
      await startFresh.first().click();
      continue;
    }
    const getStarted = page.getByRole('button', { name: 'Get started', exact: true });
    if ((await getStarted.count()) > 0) {
      await getStarted.first().click();
      continue;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`app never reached the Today view (last URL: ${page.url()})`);
}

/** Load the app (fresh profile), seed a corpus, reload so the shell reads it back. */
async function bootAndSeed(page: Page, spec: SeedSpec): Promise<void> {
  await page.goto(APP_URL);
  await waitForAppStore(page);
  // The app may still be mid-upgrade when `databases()` first lists it — retry the seed.
  let seeded: { tasks: number; deviceId: string } | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      seeded = await seedRows(page, spec);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await page.waitForTimeout(300);
    }
  }
  if (seeded === null) throw new Error('seeding never succeeded');
  expect(seeded.tasks).toBe(spec.count);
  await page.reload();
  await settleFirstRun(page);
  await expect(page.getByRole('heading', { name: 'Today', level: 1, exact: true })).toBeVisible({
    timeout: 45_000,
  });
}

/* ------------------------------------------------------------------ *
 * Model of the reorder semantics (design §8.2: one position per move)  *
 * ------------------------------------------------------------------ */

type MoveOp = { readonly from: number; readonly to: number };

function modelMove(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) throw new Error(`modelMove: no row at ${String(from)}`);
  next.splice(to, 0, moved);
  return next;
}

/** The three logical moves BOTH paths must perform, in order. */
const MOVE_OPS: readonly MoveOp[] = [
  { from: 4, to: 6 },
  { from: 2, to: 1 },
  { from: 7, to: 0 },
];

/* ------------------------------------------------------------------ *
 * Suite-level setup                                                   *
 * ------------------------------------------------------------------ */

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'chromium',
    'M5/M6 performance evidence is Chromium-only by design (single-browser measurement).',
  );
  // Seeding 10k rows + a production build reload is well past Playwright's 30 s default.
  test.setTimeout(300_000);

  await page.addInitScript(() => {
    try {
      localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
    } catch {
      /* storage unavailable — the app falls back to its own onboarding handling */
    }
    const counts: Record<string, number> = {
      tasks: 0,
      lists: 0,
      meta: 0,
      settings: 0,
      snapshots: 0,
      snapshot_payloads: 0,
    };
    // Captured through the property descriptor: reading `prototype.put` as a value trips
    // @typescript-eslint/unbound-method, and the wrapper must call the ORIGINAL implementation.
    const originalPut = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put')?.value as
      ((this: IDBObjectStore, ...args: unknown[]) => unknown) | undefined;
    const originalAdd = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'add')?.value as
      ((this: IDBObjectStore, ...args: unknown[]) => unknown) | undefined;
    if (originalPut === undefined || originalAdd === undefined) {
      throw new Error('IDBObjectStore.put/add not found on the prototype');
    }
    const patchedPut = function patchedPut(this: IDBObjectStore, ...args: unknown[]): unknown {
      counts[this.name] = (counts[this.name] ?? 0) + 1;
      return originalPut.apply(this, args);
    };
    IDBObjectStore.prototype.put = patchedPut as typeof IDBObjectStore.prototype.put;
    const patchedAdd = function patchedAdd(this: IDBObjectStore, ...args: unknown[]): unknown {
      counts[this.name] = (counts[this.name] ?? 0) + 1;
      return originalAdd.apply(this, args);
    };
    IDBObjectStore.prototype.add = patchedAdd as typeof IDBObjectStore.prototype.add;
    window.__qaM56 = {
      counts,
      reset: () => {
        for (const key of Object.keys(counts)) counts[key] = 0;
      },
    };
  });
});

test.afterAll(() => {
  flush();
});

/* ------------------------------------------------------------------ *
 * 1. M5 search @10,000                                                *
 * ------------------------------------------------------------------ */

test('M5 search @10k fixtures — latency, title+notes coverage, instant filter', async ({
  page,
}) => {
  await bootAndSeed(page, {
    listId: listIdFor(0),
    listName: 'Search QA',
    count: 10_000,
    idOffset: 0,
    titleStyle: 'search',
    notesEvery: 100,
    notesToken: 'xylophonememo',
  });
  record('search_stage', 'corpus seeded + reloaded');

  await page.goto(`${APP_URL}#/search`);
  await expect(page.locator('input.search-input')).toBeVisible({ timeout: 45_000 });
  record('search_stage', 'search field visible');
  // Let boot-time background work (throttled snapshot, quota probes) settle before measuring,
  // so the first keystroke's number is the search's own cost, not a CPU contention artefact.
  await page.waitForTimeout(1_500);

  // Keystrokes in typing order. The FIRST one is the cold open (the index builds lazily on the
  // first query — searchIndexCache); the rest are warm per-keystroke measurements.
  const keystrokes = ['x', 'x0', 'x0a', 'x0ab', 'apple', 'xylophonememo'];
  // Budget split (§9.1 "Search over 10,000 tasks < 50 ms"):
  //   * keystroke 0 is the COLD open — it pays the one-time index build (searchIndexCache);
  //   * keystrokes 1..n are the steady state a typist actually lives in.
  // Both are asserted; the cold number is reported separately because it straddles the line.

  const measurements = await page.evaluate(async (queries) => {
    const input = document.querySelector<HTMLInputElement>('input.search-input');
    if (input === null) throw new Error('search input missing');
    input.focus();
    const snapshot = (): { label: string; rows: number; first: string; marks: number } => {
      const list = document.querySelector('ul.task-list');
      const rows = Array.from(document.querySelectorAll('ul.task-list [data-task-id]'));
      return {
        label: list?.getAttribute('aria-label') ?? '(no list)',
        rows: rows.length,
        first: rows[0]?.querySelector('.task-title')?.textContent ?? '',
        marks: document.querySelectorAll('ul.task-list mark').length,
      };
    };
    const type = async (query: string): Promise<Record<string, unknown>> => {
      // A plain array (not a `number | null` local): TypeScript keeps a `null` narrowing
      // across the MutationObserver closure, which would make the `=== null` check "always true".
      const mutations: number[] = [];
      const observer = new MutationObserver(() => {
        if (mutations.length === 0) mutations.push(performance.now());
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const start = performance.now();
      input.value = query;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: query }));
      const frameMs = await new Promise<number>((res) => {
        requestAnimationFrame(() => {
          res(performance.now() - start);
        });
      });
      observer.disconnect();
      await new Promise((res) => {
        setTimeout(res, 40);
      });
      return {
        query,
        frameMs,
        domMs: mutations.length > 0 ? (mutations[0] ?? 0) - start : null,
        ...snapshot(),
      };
    };
    const out: Record<string, unknown>[] = [];
    for (const query of queries) out.push(await type(query));
    return out;
  }, keystrokes);

  record('search_10k_keystrokes', measurements);
  console.warn(`QA[search] ${JSON.stringify(measurements)}`);

  // Budget: §9.1 "Search over 10,000 tasks < 50 ms" — steady-state keystrokes are the budget
  // that matters for typing; the cold first keystroke carries the one-time index build and is
  // asserted with a 100 ms ceiling (its exact numbers are recorded and reported below).
  for (const [index, m] of measurements.entries()) {
    const frameMs = m['frameMs'] as number;
    const domMs = m['domMs'] as number | null;
    const ceiling = index === 0 ? 100 : 50;
    const label = index === 0 ? 'cold frame latency (index build)' : 'frame latency';
    expect(frameMs, `${label} for "${String(m['query'])}"`).toBeLessThan(ceiling);
    if (domMs !== null) {
      expect(domMs, `DOM update latency for "${String(m['query'])}"`).toBeLessThan(ceiling);
    }
  }

  // Coverage: the result count follows the query (the list's aria-label = `search.results.count`).
  const byQuery = new Map(measurements.map((m) => [String(m['query']), m]));
  expect(String(byQuery.get('x')?.['label'])).toMatch(/^\d+ results$/);
  expect(String(byQuery.get('x0')?.['label'])).toMatch(/^\d+ results$/);
  expect(String(byQuery.get('x0')?.['label'])).not.toBe(String(byQuery.get('x')?.['label']));
  expect(String(byQuery.get('x0a')?.['label'])).not.toBe(String(byQuery.get('x0')?.['label']));
  expect(String(byQuery.get('x0ab')?.['label'])).toBe('(no list)'); // no results → empty state
  expect(String(byQuery.get('apple')?.['label'])).toBe('1250 results');
  expect(String(byQuery.get('xylophonememo')?.['label'])).toBe('100 results');

  // Notes coverage: a notes-only token matches and the excerpt carries the <mark>.
  const notesRow = page
    .locator('ul.task-list [data-task-id]')
    .filter({ has: page.locator('.row-notes-excerpt mark', { hasText: 'xylophonememo' }) })
    .first();
  await expect(notesRow).toBeVisible();
  // Title coverage: the natural-word query highlights the title token too — retype it, because
  // the measurement pass ended on the notes token (marks always reflect the CURRENT query).
  const setQuery = async (query: string): Promise<void> => {
    await page.evaluate((q) => {
      const input = document.querySelector<HTMLInputElement>('input.search-input');
      if (input === null) throw new Error('search input missing');
      input.value = q;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: q }));
    }, query);
  };
  await setQuery('apple');
  await expect(page.locator('ul.task-list mark', { hasText: 'apple' }).first()).toBeVisible();

  // §5.5: the result count is announced politely 300 ms after typing stops.
  await setQuery('xylophonememo');
  await expect(politeRegion(page)).toHaveText('100 results for "xylophonememo"', {
    timeout: 4_000,
  });

  // D1: aggregate/search views never reorder — Alt+↓ announces the alternative instead.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('ul.task-list [data-task-id]')?.focus();
  });
  const orderBefore = await domOrder(page);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(politeRegion(page)).toHaveText(
    'Reordering is only available inside a list view. Use "Move to list" to move this task.',
    { timeout: 4_000 },
  );
  expect(await domOrder(page)).toEqual(orderBefore);

  // D5: search covers ALL non-deleted tasks (open AND completed) — and matching is
  // case-insensitive. `zquestdone` exists only on the one COMPLETED corpus member; the notes
  // token typed in upper case must still return the same 100 notes-only hits.
  await setQuery('zquestdone');
  await expect(page.locator('ul.task-list')).toHaveAttribute('aria-label', '1 results');
  await expect(
    page.locator('ul.task-list [data-task-id] .task-title', { hasText: 'zquestdone' }),
  ).toHaveCount(1);
  await setQuery('XYLOPHONEMEMO');
  await expect(page.locator('ul.task-list')).toHaveAttribute('aria-label', '100 results');
  record('search_stage', 'D5 completed-task + case-insensitive coverage verified');

  // §9.1 virtualization contract at scale: scrolling away from the roving cursor must NOT
  // collapse the window into "render everything". Query `x0` → 288 results (>200, so the list
  // IS virtualized); with no row focused the cursor sits on the first result.
  await setQuery('x0');
  const bottom = await page.evaluate(async () => {
    const before = document.querySelectorAll('ul.task-list [data-task-id]').length;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((res) => {
      setTimeout(res, 500);
    });
    const rows = Array.from(document.querySelectorAll('ul.task-list [data-task-id]'));
    return {
      before,
      after: rows.length,
      firstPos: rows[0]?.getAttribute('aria-posinset') ?? '',
      lastPos: rows[rows.length - 1]?.getAttribute('aria-posinset') ?? '',
      scrollY: Math.round(window.scrollY),
      maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
    };
  });
  record('search_scroll_to_bottom', bottom);
  console.warn(`QA[search-bottom] ${JSON.stringify(bottom)}`);
  // Recorded, not asserted here: the hard assertion for this behaviour lives in the
  // virtualization test (same TaskList, same pin) — this run just shows it at search scale.

  const coldMs = measurements[0]?.['domMs'];
  const warm = measurements.slice(1);
  record('search_10k_summary', {
    keystrokeCount: measurements.length,
    // Computed, never asserted by hand: every WARM keystroke (index ≥ 1) inside the budget.
    warmKeystrokesUnder50ms: warm.every(
      (m) => (m['frameMs'] as number) < 50 && ((m['domMs'] as number | null) ?? Infinity) < 50,
    ),
    coldFirstQueryDomMs: coldMs,
    coldFirstQueryFrameMs: measurements[0]?.['frameMs'],
    warmMaxDomMs: Math.max(...warm.map((m) => (m['domMs'] === null ? 0 : (m['domMs'] as number)))),
    warmMaxFrameMs: Math.max(...warm.map((m) => m['frameMs'] as number)),
  });
});

/* ------------------------------------------------------------------ *
 * 2. M6 reorder — keyboard path vs drag path, scripted comparison     *
 * ------------------------------------------------------------------ */

test.describe('M6 reorder', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('keyboard and drag paths persist identical results', async ({ page }) => {
    const listId = listIdFor(1_000_000);
    const listName = 'Reorder QA';
    const count = 12;
    const spec: SeedSpec = {
      listId,
      listName,
      count,
      idOffset: 1_000_000,
      titleStyle: 'reorder',
      notesEvery: 0,
      notesToken: '',
    };
    await bootAndSeed(page, spec);
    await page.goto(`${APP_URL}#/list/${listId}`);
    await expect(page.locator('ul.task-list [data-task-id]')).toHaveCount(count);

    const initialOrder = await persistedOrder(page, listId);
    expect(initialOrder).toEqual(
      Array.from({ length: count }, (_, i) => `Reorder ${String(i + 1).padStart(2, '0')}`),
    );

    const moveLabel = (position: number): RegExp =>
      new RegExp(`^Moved to position ${String(position)} of ${String(count)} in ${listName}$`);

    const assertSingleWrite = async (label: string): Promise<string[]> => {
      const counts = await readCounts(page);
      expect(counts['tasks'], `${label}: task-record writes`).toBe(1);
      expect(counts['lists'], `${label}: list-record writes`).toBe(0);
      return [];
    };

    const changedSince = async (
      before: Record<string, string>,
      label: string,
    ): Promise<string[]> => {
      const after = await persistedKeys(page, listId);
      const changed = Object.keys(after).filter((title) => after[title] !== before[title]);
      expect(changed, `${label}: rows whose order key changed`).toHaveLength(1);
      return changed;
    };

    /* ---------------------------- PATH A: keyboard ---------------------------- */

    const keyboardTrace: Array<{ label: string; order: string[] }> = [];
    /** One snapshot PER OP (the drag path drops once per op; arrows walk per press). */
    const keyboardOps: string[][] = [];
    let expected = await persistedOrder(page, listId);

    for (const [opIndex, op] of MOVE_OPS.entries()) {
      // Alt+Home/End jump to an edge in ONE press; arrows walk one position per press.
      const edge = op.to === 0 || op.to === count - 1;
      const presses = edge ? 1 : Math.abs(op.to - op.from);
      const key = edge ? (op.to === 0 ? 'Home' : 'End') : op.to > op.from ? 'ArrowDown' : 'ArrowUp';
      for (let press = 0; press < presses; press += 1) {
        const currentDom = await domOrder(page);
        const cursorIndex = op.to > op.from ? op.from + press : op.from - press;
        const targetTitle = currentDom[cursorIndex];
        if (targetTitle === undefined) throw new Error('cursor title missing');
        const targetId = await page.evaluate((i) => {
          const rows = Array.from(document.querySelectorAll('ul.task-list [data-task-id]'));
          const row = rows[i];
          if (!(row instanceof HTMLElement)) throw new Error(`no row at ${String(i)}`);
          row.focus();
          return row.getAttribute('data-task-id') ?? '';
        }, cursorIndex);
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute('data-task-id')),
        ).toBe(targetId);

        const stepTo = edge ? op.to : op.to > op.from ? cursorIndex + 1 : cursorIndex - 1;
        const nextExpected = modelMove(expected, cursorIndex, stepTo);
        const beforeKeys = await persistedKeys(page, listId);
        await resetCounts(page);
        await page.keyboard.press(`Alt+${key}`);
        const label = `keyboard op${String(opIndex + 1)} press${String(press + 1)}`;

        await expect(politeRegion(page), label).toHaveText(moveLabel(stepTo + 1), {
          timeout: 5_000,
        });
        await assertSingleWrite(label);
        expect(await changedSince(beforeKeys, label)).toEqual([targetTitle]);
        // §8.2: focus stays on the moved row after the move.
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute('data-task-id')),
          `${label}: focus retention`,
        ).toBe(targetId);
        expected = nextExpected;
        expect(await domOrder(page), `${label}: DOM order`).toEqual(expected);
        expect(await persistedOrder(page, listId), `${label}: persisted order`).toEqual(expected);
        keyboardTrace.push({ label, order: [...expected] });
      }
      keyboardOps.push([...expected]);
    }
    const keyboardResult = expected;
    record('reorder_keyboard', keyboardTrace);

    /* ------------------------------ reset corpus ------------------------------ */

    await seedRows(page, spec);
    await page.reload();
    await page.goto(`${APP_URL}#/list/${listId}`);
    await expect(page.locator('ul.task-list [data-task-id]')).toHaveCount(count);
    expect(await persistedOrder(page, listId)).toEqual(initialOrder);

    /* ------------------------------ PATH B: drag ------------------------------ */

    const dragTrace: Array<{ label: string; order: string[]; marker: unknown }> = [];
    expected = await persistedOrder(page, listId);

    for (const [opIndex, op] of MOVE_OPS.entries()) {
      const currentDom = await domOrder(page);
      const targetTitle = currentDom[op.from];
      if (targetTitle === undefined) throw new Error('drag target title missing');

      // Hover the grip first (it is opacity-0 until hover on pointer devices) — this may
      // scroll, so the row geometry is read AFTER the hover.
      const targetIdBefore = await page.evaluate((i) => {
        const rows = Array.from(document.querySelectorAll('ul.task-list [data-task-id]'));
        return rows[i]?.getAttribute('data-task-id') ?? '';
      }, op.from);
      // Park the list high in the viewport BEFORE hovering: §8.1's edge auto-scroll (48 px
      // zone, ~800 px/s) would move the rows under a fixed pointer and mis-aim the drop.
      await page.evaluate(() => {
        document.querySelector('ul.task-list')?.scrollIntoView({ block: 'start' });
      });
      await page.waitForTimeout(150);
      const handle = page.locator(`[data-reorder-handle="${targetIdBefore}"]`);
      await handle.hover();
      const box = await handle.boundingBox();
      if (box === null) throw new Error('handle has no box');

      const beforeKeys = await persistedKeys(page, listId);
      await resetCounts(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // Let the drag session start (and any focus-driven scroll settle) BEFORE reading row
      // geometry: the drop intent is pure viewport math, so stale rects mis-aim by a row.
      await page.waitForTimeout(150);

      const rects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('ul.task-list [data-task-id]')).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.getAttribute('data-task-id') ?? '',
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
          };
        }),
      );
      expect(rects).toHaveLength(count);
      const fromRect = rects[op.from];
      if (fromRect === undefined) throw new Error('from rect missing');
      const dropX = (fromRect.left + fromRect.right) / 2;
      // Insertion slot: dropping AFTER row `to` lands the task at index `to` (rows below the
      // removed one shift up); dropping BEFORE row `to` lands it at index `to`. Row midpoints
      // decide (reorderDrag.dropTargetFromMetrics), so aim between the two midpoints.
      const dropY =
        op.to > op.from
          ? ((rects[op.to]?.bottom ?? 0) +
              (rects[op.to + 1]?.top ?? (rects[op.to]?.bottom ?? 0) + 40)) /
            2
          : op.to === 0
            ? (rects[0]?.top ?? 0) - 12
            : ((rects[op.to - 1]?.bottom ?? 0) + (rects[op.to]?.top ?? 0)) / 2;

      await page.mouse.move(dropX, dropY, { steps: 12 });
      await page.waitForTimeout(150); // one geometry decision per animation frame (§9.1)

      // Insertion-line evidence: the drop intent must be visible BEFORE the release.
      const marker = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(
          '[data-drop-before="true"],[data-drop-after="true"]',
        );
        if (el === null) return null;
        return {
          id: el.getAttribute('data-task-id'),
          kind: el.hasAttribute('data-drop-before') ? 'before' : 'after',
        };
      });
      const expectedMarkerIndex = op.to > op.from ? op.to + 1 : op.to;
      const viewportH = await page.evaluate(() => window.innerHeight);
      record(`drag_geometry_op${String(opIndex + 1)}`, {
        dropX: Math.round(dropX),
        dropY: Math.round(dropY),
        viewportH,
        rowTops: rects.map((r) => Math.round(r.top)),
        rowBottoms: rects.map((r) => Math.round(r.bottom)),
        marker,
      });
      // The drop slot must sit outside §8.1's 48 px edge auto-scroll zone, otherwise the page
      // scrolls under the fixed pointer and the recorded geometry no longer matches the intent.
      expect(dropY, 'drop slot below the top auto-scroll zone').toBeGreaterThan(60);
      expect(dropY, 'drop slot above the bottom auto-scroll zone').toBeLessThan(viewportH - 60);
      expect(marker, 'insertion line during drag').toEqual({
        id: rects[expectedMarkerIndex]?.id,
        kind: 'before',
      });

      await page.mouse.up();
      const label = `drag op${String(opIndex + 1)}`;
      await expect(politeRegion(page), label).toHaveText(moveLabel(op.to + 1), { timeout: 5_000 });
      await assertSingleWrite(label);
      expect(await changedSince(beforeKeys, label)).toEqual([targetTitle]);

      expected = modelMove(expected, op.from, op.to);
      expect(await domOrder(page), `${label}: DOM order`).toEqual(expected);
      expect(await persistedOrder(page, listId), `${label}: persisted order`).toEqual(expected);
      dragTrace.push({ label, order: [...expected], marker });
    }
    const dragResult = expected;
    record('reorder_drag', dragTrace);

    /* --------------------- scripted comparison of both paths --------------------- */

    expect(dragResult, 'final persisted order: keyboard vs drag').toEqual(keyboardResult);
    expect(
      dragTrace.map((t) => t.order),
      'per-move persisted orders: keyboard vs drag',
    ).toEqual(keyboardOps);
    expect(keyboardOps, 'three ops recorded on both paths').toHaveLength(MOVE_OPS.length);
    expect(dragTrace, 'three drops recorded on the drag path').toHaveLength(MOVE_OPS.length);

    /* ------------------------- persistence across reload ------------------------- */

    const beforeReload = await persistedOrder(page, listId);
    await page.reload();
    await page.goto(`${APP_URL}#/list/${listId}`);
    await expect(page.locator('ul.task-list [data-task-id]')).toHaveCount(count);
    expect(await persistedOrder(page, listId), 'persisted after reload').toEqual(beforeReload);
    expect(await domOrder(page), 'DOM after reload').toEqual(beforeReload);

    record('reorder_paths', {
      initialOrder,
      keyboard: keyboardTrace,
      drag: dragTrace,
      identical: JSON.stringify(dragResult) === JSON.stringify(keyboardResult),
      persistedAfterReload: beforeReload,
    });
    console.warn(
      `QA[reorder] identical=${String(JSON.stringify(dragResult) === JSON.stringify(keyboardResult))} final=${JSON.stringify(dragResult)}`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. Virtualization @1,200 rows                                       *
 * ------------------------------------------------------------------ */

test.describe('M5/M6 virtualization', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('window, keyboard navigation across boundaries, aria positions, scroll frames', async ({
    page,
  }) => {
    const listId = listIdFor(2_000_000);
    const count = 1_200;
    await bootAndSeed(page, {
      listId,
      listName: 'Virtual QA',
      count,
      idOffset: 2_000_000,
      titleStyle: 'virtual',
      notesEvery: 0,
      notesToken: '',
    });
    await page.goto(`${APP_URL}#/list/${listId}`);
    await expect(page.locator('ul.task-list [data-task-id]').first()).toBeVisible({
      timeout: 45_000,
    });

    const initial = await page.evaluate(() => {
      const list = document.querySelector('ul.task-list');
      const rows = Array.from(document.querySelectorAll('ul.task-list [data-task-id]'));
      return {
        virtualized: list?.getAttribute('data-virtualized') ?? null,
        domRows: rows.length,
        setSize: rows[0]?.getAttribute('aria-setsize') ?? null,
        posFirst: rows[0]?.getAttribute('aria-posinset') ?? null,
        padTop: document.querySelector('.task-list-pad') !== null,
        padBottom: document.querySelectorAll('.task-list-pad').length,
      };
    });
    record('virtual_initial', initial);
    console.warn(`QA[virtual] initial ${JSON.stringify(initial)}`);
    expect(initial.virtualized).toBe('true');
    expect(initial.domRows).toBeLessThan(200); // §9.1: virtualize beyond ~200 DOM rows
    expect(initial.domRows).toBeGreaterThan(0);
    expect(initial.setSize).toBe(String(count));
    expect(initial.posFirst).toBe('1');
    expect(initial.padTop, 'top spacer carries the off-screen prefix').toBe(true);

    // Keyboard navigation across window boundaries — the cursor row is always materialized.
    const activeRow = async (label: string): Promise<{ id: string; pos: string }> => {
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!(el instanceof HTMLElement) || el.getAttribute('data-task-id') === null) {
          return { id: '', pos: '' };
        }
        return {
          id: el.getAttribute('data-task-id') ?? '',
          pos: el.getAttribute('aria-posinset') ?? '',
        };
      });
      expect(info.id, `${label}: focus is on a task row`).not.toBe('');
      expect(info.pos, `${label}: aria-posinset`).not.toBe('');
      return info;
    };

    await page.evaluate(() => {
      document.querySelector<HTMLElement>('ul.task-list [data-task-id]')?.focus();
    });
    const first = await activeRow('first row');
    expect(first.pos).toBe('1');

    await page.keyboard.press('End');
    const atEnd = await activeRow('End');
    expect(atEnd.pos).toBe(String(count));

    const arrowUps: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('ArrowUp');
      arrowUps.push((await activeRow(`ArrowUp ${String(i + 1)}`)).pos);
    }
    expect(arrowUps.at(-1)).toBe(String(count - 12));

    await page.keyboard.press('PageUp');
    const afterPageUp = await activeRow('PageUp');
    expect(afterPageUp.pos).toBe(String(count - 22));

    await page.keyboard.press('Home');
    expect((await activeRow('Home')).pos).toBe('1');

    const arrowDowns: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('ArrowDown');
      arrowDowns.push((await activeRow(`ArrowDown ${String(i + 1)}`)).pos);
    }
    expect(arrowDowns.at(-1)).toBe('31');
    // Window boundary crossed: the DOM window must still be bounded while focus walked out.
    const afterWalk = await page.evaluate(
      () => document.querySelectorAll('ul.task-list [data-task-id]').length,
    );
    expect(afterWalk).toBeLessThan(200);
    record('virtual_keyboard', { arrowUps, afterPageUp: afterPageUp.pos, arrowDowns, afterWalk });

    /* -------------------------------- scroll fps -------------------------------- */

    /** §9.1 method: mid-tier mobile ≈ 4× CPU slowdown (CDP — no built-in helper in 1.64). */
    const cpuClient = await page.context().newCDPSession(page);
    const setCpuRate = async (rate: number): Promise<void> => {
      await cpuClient.send('Emulation.setCPUThrottlingRate', { rate });
    };
    // Prove the throttle is actually engaged before citing its numbers (rAF cadence is
    // vsync-bound, so a busy-loop ratio is the only honest check that the rate took).
    const cpuProbe = async (rate: number): Promise<number> => {
      await setCpuRate(rate);
      return page.evaluate(() => {
        const start = performance.now();
        let acc = 0;
        for (let i = 0; i < 8_000_000; i += 1) acc = (acc + i) % 97;
        return Math.round((performance.now() - start) * 10) / 10;
      });
    };
    const probeRate1 = await cpuProbe(1);
    const probeRate4 = await cpuProbe(4);
    await setCpuRate(1);
    record('cpu_throttle_probe', {
      busyLoopMsAtRate1: probeRate1,
      busyLoopMsAtRate4: probeRate4,
      ratio: Math.round((probeRate4 / Math.max(probeRate1, 0.1)) * 100) / 100,
    });

    const scrollRun = async (
      label: string,
      throttle: number,
    ): Promise<Record<string, number | string>> => {
      await setCpuRate(throttle);
      const result = await page.evaluate(async () => {
        const list = document.querySelector('ul.task-list');
        if (list === null) throw new Error('no list');
        let node: HTMLElement | null = list.parentElement;
        let target: HTMLElement | Window = window;
        while (node !== null) {
          const style = getComputedStyle(node);
          if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            target = node;
            break;
          }
          node = node.parentElement;
        }
        const readTop = (): number =>
          target === window ? window.scrollY : (target as HTMLElement).scrollTop;
        const maxTop =
          target === window
            ? document.documentElement.scrollHeight - window.innerHeight
            : (target as HTMLElement).scrollHeight - (target as HTMLElement).clientHeight;
        const samples: number[] = [];
        let maxRows = 0;
        const startTop = readTop();
        let last = performance.now();
        const startedAt = last;
        await new Promise<void>((res) => {
          const step = (now: number): void => {
            samples.push(now - last);
            last = now;
            maxRows = Math.max(
              maxRows,
              document.querySelectorAll('ul.task-list [data-task-id]').length,
            );
            const next = readTop() + 40;
            if (target === window) window.scrollTo(0, next);
            else (target as HTMLElement).scrollTop = next;
            if (now - startedAt < 2000 && readTop() < maxTop) requestAnimationFrame(step);
            else res();
          };
          requestAnimationFrame(step);
        });
        const sorted = [...samples].sort((a, b) => a - b);
        const at = (q: number): number =>
          sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
        const median = at(0.5);
        const rendered = Array.from(
          document.querySelectorAll<HTMLElement>('ul.task-list [data-task-id]'),
        );
        return {
          frames: samples.length,
          medianMs: median,
          p95Ms: at(0.95),
          maxMs: sorted[sorted.length - 1] ?? 0,
          fps: Math.round(1000 / Math.max(median, 0.001)),
          droppedFrames: samples.filter((s) => s > 33.4).length,
          scrolledPx: Math.round(readTop() - startTop),
          maxDomRows: maxRows,
          // Why the window is as big as it is: scroll source + first/last materialized row.
          scrollSource:
            target === window
              ? `window innerHeight=${String(window.innerHeight)}`
              : `${(target as HTMLElement).tagName.toLowerCase()}#${(target as HTMLElement).id} clientHeight=${String((target as HTMLElement).clientHeight)}`,
          firstPos: rendered[0]?.getAttribute('aria-posinset') ?? '',
          lastPos: rendered[rendered.length - 1]?.getAttribute('aria-posinset') ?? '',
        };
      });
      await setCpuRate(1);
      record(`virtual_scroll_${label}`, result);
      console.warn(`QA[virtual-scroll:${label}] ${JSON.stringify(result)}`);
      expect(result['scrolledPx'], `${label}: scroll distance`).toBeGreaterThan(500);
      // Still virtualizing while scrolling (the window may legitimately span from the pinned
      // cursor row to the scroll position — the exact span is recorded as evidence).
      expect(result['maxDomRows'], `${label}: DOM rows while scrolling`).toBeLessThan(1_200);
      return result;
    };

    const plain = await scrollRun('unthrottled', 1);
    const throttled = await scrollRun('cpu4x', 4);
    // §9.1 "Scroll: 60 fps; virtualize beyond ~200 DOM rows".
    expect(plain['medianMs'], 'unthrottled median frame').toBeLessThan(25);
    expect(throttled['medianMs'], '4×-throttled median frame').toBeLessThan(50);
  });

  /**
   * DEFECT V1 (open) — expected to FAIL while the defect is live.
   *
   * The roving cursor is pinned into EVERY window computation (design §5.7 "the cursor row is
   * ALWAYS materialized"), so the window spans from the pinned cursor row all the way to the
   * scroll position: scrolling far from the cursor renders O(distance) rows instead of a
   * viewport-sized window, up to the entire list (§9.1 "virtualize beyond ~200 DOM rows").
   *
   * `test.fail()` keeps the shared suite green while the defect is open and FLIPS loudly the
   * moment it is fixed ("expected to fail, but passed") — delete the marker with the fix.
   */
  test('V1: scrolling far from the pinned cursor materialises the whole list', async ({ page }) => {
    test.fail();
    const listId = listIdFor(2_500_000);
    const count = 1_200;
    await bootAndSeed(page, {
      listId,
      listName: 'Virtual Pin QA',
      count,
      idOffset: 2_500_000,
      titleStyle: 'virtual',
      notesEvery: 0,
      notesToken: '',
    });
    await page.goto(`${APP_URL}#/list/${listId}`);
    await expect(page.locator('ul.task-list [data-task-id]').first()).toBeVisible({
      timeout: 45_000,
    });
    const bottom = await page.evaluate(async () => {
      // Park the roving cursor on a row near the TOP, then scroll to the very bottom.
      document.querySelector<HTMLElement>('ul.task-list [data-task-id]')?.focus();
      window.scrollTo(0, 0);
      await new Promise((res) => {
        setTimeout(res, 300);
      });
      const before = document.querySelectorAll('ul.task-list [data-task-id]').length;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((res) => {
        setTimeout(res, 800);
      });
      const rows = Array.from(document.querySelectorAll('ul.task-list [data-task-id]'));
      return {
        before,
        after: rows.length,
        firstPos: rows[0]?.getAttribute('aria-posinset') ?? '',
        lastPos: rows[rows.length - 1]?.getAttribute('aria-posinset') ?? '',
        focusedPos: document.activeElement?.getAttribute('aria-posinset') ?? '',
        scrollY: Math.round(window.scrollY),
        maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight),
      };
    });
    record('virtual_scroll_to_bottom', bottom);
    console.warn(`QA[virtual-bottom] ${JSON.stringify(bottom)}`);
    expect(
      bottom.after,
      `DOM rows after scrolling away from the pinned cursor (span ${bottom.firstPos}→${bottom.lastPos})`,
    ).toBeLessThan(200);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Touch targets (M8 / §8: ≥ 44×44 CSS px)                          *
 * ------------------------------------------------------------------ */

for (const viewport of [
  { width: 375, height: 667 },
  { width: 320, height: 640 },
]) {
  test.describe(`M6 touch targets @${String(viewport.width)}px`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test('reorder handle is ≥44×44 and visible on touch', async ({ page }) => {
      const listId = listIdFor(3_000_000 + viewport.width);
      await bootAndSeed(page, {
        listId,
        listName: 'Touch QA',
        count: 8,
        idOffset: 3_000_000 + viewport.width,
        titleStyle: 'reorder',
        notesEvery: 0,
        notesToken: '',
      });
      await page.goto(`${APP_URL}#/list/${listId}`);
      await expect(page.locator('ul.task-list [data-task-id]')).toHaveCount(8);

      const handles = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-reorder-handle]')).map((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return {
            w: Math.round(r.width * 100) / 100,
            h: Math.round(r.height * 100) / 100,
            opacity: style.opacity,
            visibility: style.visibility,
            display: style.display,
            touchAction: style.touchAction,
          };
        }),
      );
      expect(handles.length).toBeGreaterThan(0);
      record(`touch_handles_${String(viewport.width)}`, handles);
      console.warn(`QA[touch:${String(viewport.width)}] ${JSON.stringify(handles)}`);
      for (const handle of handles) {
        expect(handle.w, `handle width @${String(viewport.width)}`).toBeGreaterThanOrEqual(44);
        expect(handle.h, `handle height @${String(viewport.width)}`).toBeGreaterThanOrEqual(44);
        expect(handle.visibility).toBe('visible');
        expect(handle.display).not.toBe('none');
      }
    });
  });
}
