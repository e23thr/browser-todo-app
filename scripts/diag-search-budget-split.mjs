// Split probe for tests/e2e/qa-search-reorder.spec.ts:421's two §9.1 perf budgets:
//
//   * cold open (keystroke 0) < 100 ms
//   * warm keystrokes < 50 ms
//
// Each asserted number is split into what the APP did versus what the SCHEDULER did, all on the
// page clock (no test-process round trip lands in any of them):
//
//   domMs     = input dispatch -> the app's FIRST DOM mutation (the app's own update latency)
//   frameMs   = input dispatch -> next requestAnimationFrame    (what the test asserts today)
//   frameWait = frameMs - domMs                                 (pure frame/scheduler wait)
//   yieldMs   = input dispatch -> a 0 ms timer queued BEFORE the dispatch fired;
//               yieldMs < domMs proves a MACROTASK ran between the keystroke and the app's
//               update, i.e. the window holds work that is not the search
//   longtasks = PerformanceObserver('longtask') entries overlapping the window; more than the
//               app's own chunk also proves the window is not one uninterrupted piece of work
//
// Plus load context (a fixed calibration loop + event-loop lag sampled before every trial) and a
// red-before-green pass: with SLOW_INPUT_MS set, a genuinely slow input->render path must still
// land OVER the (unchanged) budget lines when asserted on the app clock.
//
// Run against the production preview:
//   BASE_PATH=/browser-todo-app/ npx vite preview --host 127.0.0.1 --port 4193
//   node scripts/diag-search-budget-split.mjs
import { chromium } from 'playwright-core';

const APP = process.env['APP'] ?? 'http://127.0.0.1:4193/browser-todo-app/';
const TRIALS = Number(process.env['TRIALS'] ?? 3);
const SLOW_INPUT_MS = Number(process.env['SLOW_INPUT_MS'] ?? 0);
const KEYSTROKES = ['x', 'x0', 'x0a', 'x0ab', 'apple', 'xylophonememo'];
const LIST_ID = '01ARZ3NDEKTSV4RRFFR0000000';
const COLD_LINE = 100;
const WARM_LINE = 50;

/** Seed the corpus the spec seeds (titleStyle 'search', notes on every 100th, one done task). */
async function seed(page) {
  await page.evaluate(
    async ({ listId, count }) => {
      const db = await new Promise((res, rej) => {
        const request = indexedDB.open('local-first-todo');
        request.onsuccess = () => res(request.result);
        request.onerror = () => rej(new Error(`IDB open failed: ${String(request.error)}`));
      });
      const meta = await new Promise((res, rej) => {
        const tx = db.transaction('meta', 'readonly');
        const request = tx.objectStore('meta').get('meta');
        request.onsuccess = () => res(request.result);
        request.onerror = () => rej(new Error('meta read failed'));
      });
      const deviceId = meta?.['deviceId'];
      if (typeof deviceId !== 'string') throw new Error('meta.deviceId missing');
      const now = Date.now();
      const prefix = '01ARZ3NDEKTSV4RRFFQ';
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        const word = `x${(i % 1296).toString(36).padStart(2, '0')}`;
        const title = `Fixture ${String(i + 1).padStart(5, '0')} ${word}${i % 8 === 0 ? ' apple' : ''}`;
        const hasNotes = i % 100 === 0;
        const isDone = i === 5;
        rows.push({
          id: `${prefix}${String(i).padStart(7, '0')}`,
          listId,
          title: isDone ? `${title} zquestdone` : title,
          notes: hasNotes ? `note xylophonememo ${String(i)}` : null,
          status: isDone ? 'done' : 'open',
          priority: 0,
          tags: [],
          sortOrder: `h${i.toString(36).padStart(6, '0')}z`,
          createdAt: now - (count - i),
          updatedAt: now - (count - i),
          ...(isDone ? { completedAt: now - (count - i) + 1 } : {}),
          deletedAt: null,
          deviceId,
        });
      }
      await new Promise((res, rej) => {
        const tx = db.transaction(['lists', 'tasks'], 'readwrite');
        tx.objectStore('lists').put({
          id: listId,
          name: 'Search QA',
          color: '#336699',
          sortOrder: 'h',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          deviceId,
        });
        const store = tx.objectStore('tasks');
        for (const row of rows) store.put(row);
        tx.oncomplete = () => res(undefined);
        tx.onerror = () => rej(new Error('seed tx failed'));
        tx.onabort = () => rej(new Error('seed tx aborted'));
      });
      db.close();
      return rows.length;
    },
    { listId: LIST_ID, count: 10_000 },
  );
}

/** Walk first-run the way the spec does (the init script already dismisses onboarding). */
async function settle(page) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if ((await page.getByRole('heading', { name: 'Today', level: 1, exact: true }).count()) > 0) {
      return;
    }
    for (const name of ['Start fresh', 'Get started']) {
      const button = page.getByRole('button', { name, exact: true });
      if ((await button.count()) > 0) {
        await button.first().click();
        break;
      }
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`app never reached the Today view (last URL: ${page.url()})`);
}

/** Calibration: wall time of a fixed CPU loop + one event-loop hop, sampled before each trial. */
async function loadContext(page) {
  return page.evaluate(async () => {
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 3_000_000; i += 1) acc += Math.sqrt(i);
    const calibMs = performance.now() - t0;
    const t1 = performance.now();
    await new Promise((res) => setTimeout(res, 0));
    return {
      calibMs: Math.round(calibMs * 10) / 10,
      lagMs: Math.round((performance.now() - t1) * 10) / 10,
      acc: Math.round(acc),
    };
  });
}

/** The spec's measurement shape, plus the split fields. */
async function measure(page, queries, slowInputMs) {
  return page.evaluate(
    async ({ qs, slowMs }) => {
      if (slowMs > 0) {
        // Red-before-green injection: work between the input event and the app's own handler —
        // a genuinely slow input->render path, exactly the regression the budgets exist for.
        document.addEventListener(
          'input',
          () => {
            const until = performance.now() + slowMs;
            while (performance.now() < until) {
              /* simulated slow handler */
            }
          },
          { capture: true },
        );
      }
      const input = document.querySelector('input.search-input');
      if (input === null) throw new Error('search input missing');
      input.focus();
      const out = [];
      for (const query of qs) {
        const mutations = [];
        const observer = new MutationObserver(() => {
          if (mutations.length === 0) mutations.push(performance.now());
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
        let yieldAt = null;
        const timer = setTimeout(() => {
          yieldAt = performance.now();
        }, 0);
        const start = performance.now();
        input.value = query;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: query }));
        const frameMs = await new Promise((res) => {
          requestAnimationFrame(() => {
            res(performance.now() - start);
          });
        });
        const end = performance.now();
        clearTimeout(timer);
        observer.disconnect();
        const domMs = mutations.length > 0 ? mutations[0] - start : null;
        const list = document.querySelector('ul.task-list');
        out.push({
          query,
          start,
          end,
          frameMs,
          domMs,
          yieldMs: yieldAt === null ? null : yieldAt - start,
          frameWaitMs: domMs === null ? null : frameMs - domMs,
          rows: document.querySelectorAll('ul.task-list [data-task-id]').length,
          marks: document.querySelectorAll('ul.task-list mark').length,
          label: list?.getAttribute('aria-label') ?? '(no list)',
        });
        await new Promise((res) => {
          setTimeout(res, 40);
        });
      }
      return out;
    },
    { qs: queries, slowMs: slowInputMs },
  );
}

function report(label, trials) {
  console.log(`\n== ${label} ==`);
  console.log(
    'trial | keystroke | appClock | frame (wait) | yield | rows/marks | results | longtasks',
  );
  for (const [i, t] of trials.entries()) {
    for (const [j, m] of t.measurements.entries()) {
      const line = j === 0 ? 'COLD' : `warm${String(j)}`;
      const line100 = j === 0 ? COLD_LINE : WARM_LINE;
      const coldOver = m.domMs >= line100;
      const frameOver = m.frameMs >= line100;
      const verdict = coldOver
        ? frameOver
          ? ' <= OVER (both bases)'
          : ' <= OVER (app clock only)'
        : frameOver
          ? ' <= OVER (frame basis only)'
          : '';
      console.log(
        `  ${String(i)}   | ${line} ${m.query.padEnd(14)} | ` +
          `${String(Math.round(m.domMs ?? -1)).padStart(5)} ms | ` +
          `${String(Math.round(m.frameMs)).padStart(5)} ms (${String(Math.round(m.frameWaitMs ?? -1)).padStart(4)}) | ` +
          `${String(Math.round(m.yieldMs ?? -1)).padStart(4)} | ` +
          `${String(m.rows).padStart(4)}/${String(m.marks).padStart(3)} | ${m.label.padEnd(14)} | ` +
          `${t.longTasks.get(m) ?? 0}${(t.longTasks.get(m) ?? 0) > 1 ? '  << window is NOT one uninterrupted chunk' : ''}${verdict}`,
      );
    }
    console.log(
      `        load context: calib=${String(t.context.calibMs)}ms eventLoopLag=${String(t.context.lagMs)}ms`,
    );
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
  } catch {
    /* storage unavailable — the app falls back to its own onboarding handling */
  }
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask timing is chromium-only — the other columns still report */
  }
});

await page.goto(APP);
await page
  .getByRole('heading', { name: 'Today', level: 1, exact: true })
  .waitFor({ timeout: 60_000 });
await seed(page);
console.log(`seeded 10k at ${APP}`);

const runTrial = async (slowInputMs) => {
  // Back to the shell root first (the previous trial ended on #/search) and then a real reload:
  // a fresh tab-level boot is what resets `searchIndexCache`, so keystroke 0 is cold again.
  await page.goto(APP);
  await page.reload();
  await settle(page);
  await page.goto(`${APP}#/search`);
  await page.locator('input.search-input').waitFor({ timeout: 45_000 });
  // The spec's own settle: let boot-time background work drain before measuring.
  await page.waitForTimeout(1_500);
  const context = await loadContext(page);
  const measurements = await measure(page, KEYSTROKES, slowInputMs);
  // Long tasks are delivered to the observer only once their task ends, so they are correlated
  // here, after the measurement evaluate returned — never inside it.
  const tasks = await page.evaluate(() => window.__longTasks ?? []);
  const longTasks = new Map();
  for (const m of measurements) {
    // Overlap, not containment: the cold window's own long task starts BEFORE the dispatch (the
    // evaluate task began earlier), so a containment filter would hide exactly the evidence
    // that matters.
    const inWindow = tasks.filter(
      (task) => task.start <= m.end && task.start + task.duration >= m.start,
    );
    longTasks.set(m, inWindow.length);
    console.log(
      `        window ${m.query}: longtasks=[${inWindow
        .map(
          (task) =>
            `${Math.round(task.start - m.start)}ms..${Math.round(task.start + task.duration - m.start)}ms`,
        )
        .join(', ')}]`,
    );
  }
  return { context, measurements, longTasks };
};

const trials = [];
for (let i = 0; i < TRIALS; i += 1) trials.push(await runTrial(0));
report(`healthy app (SLOW_INPUT_MS=0, ${String(TRIALS)} cold trials)`, trials);

if (SLOW_INPUT_MS > 0) {
  const slowTrials = [await runTrial(SLOW_INPUT_MS)];
  report(`regression injection: input path slowed by ${String(SLOW_INPUT_MS)} ms`, slowTrials);
}

await browser.close();
