// Root-cause probe for theme-boot:143 (Nightly 40250045123): the shell-bound helper read
// probe.fcp IMMEDIATELY after expect(heading).toBeVisible() and saw null under runner load.
//
// Mechanism (deterministic): the shell's #app starts EMPTY, so the h1 "Today" is the page's
// first contentful paint. Playwright's visible-check passes on LAYOUT — which happens in the
// rendering frame BEFORE that frame's paint emits FCP. An in-page rAF scan (rAF callbacks run
// pre-paint) records the first frame where the h1 has a box; the FCP timeline is empty at that
// instant on EVERY load (RED below) — i.e. layout-visible is NOT ordered after FCP, the helper's
// read survives only by timing: CDP round trip vs paint+observer-delivery. On a loaded runner
// the paint side loses (40250045123: probe.fcp===null at :114, retry passed).
// The script reports both race quantities (window vs helper read round trip) and counts loads
// where the OLD read semantics would actually fail (immediate read sees null), then proves the
// GREEN fix (waitForFunction on fcp — the same wait the first-run scenario uses at :186):
// never null, theme-before-FCP ordering intact.
// DIAG_LOAD_LOOPS=N adds pinned-core spin loops (the loaded-runner condition).
// Run against a preview: npm run build && npx vite preview.
import { spawn } from 'node:child_process';

import { chromium } from 'playwright-core';

const PORT = Number(process.env['E2E_PORT'] ?? 4173);
const APP = `http://127.0.0.1:${String(PORT)}/browser-todo-app/`;
const ITERATIONS = Number(process.env['DIAG_ITERATIONS'] ?? 12);
const LOAD_LOOPS = Number(process.env['DIAG_LOAD_LOOPS'] ?? 0);

let redAtFirstVisible = 0; // deterministic hazard: FCP absent pre-paint at first layout-visible
let redAtOldRead = 0; // loads where the OLD helper read itself would have failed at :114
let waitedNulls = 0;
let orderingViolations = 0;
const windows = []; // ms: first layout-visible -> fcp delivered
const readLags = []; // ms: heading waitFor('visible') resolves -> old read's evaluate returns

const hogs = Array.from({ length: LOAD_LOOPS }, () =>
  spawn('node', ['-e', 'while (true) {}'], { stdio: 'ignore' }),
);

try {
  const browser = await chromium.launch();

  for (let i = 0; i < ITERATIONS; i++) {
    const context = await browser.newContext();
    const scanEnabled = process.env['DIAG_SCAN'] !== '0';
    await context.addInitScript((scanEnabledParam) => {
      const w = window;
      try {
        w.localStorage.setItem('todo:prefs:v1:theme', 'dark');
        w.localStorage.setItem('todo:prefs:v1:onboardingStep', 'done');
      } catch {
        /* hardened mode */
      }

      const probe = { events: [], fcp: null };
      w.__themeProbe = probe;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') probe.fcp = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });

      // Pre-paint scan: rAF callbacks run BEFORE the frame's paint, so this records the first
      // frame in which the h1 reads layout-visible — the earliest instant Playwright's
      // visible-check can pass — and whether FCP existed at that instant. Registered BEFORE any
      // documentElement access (the init script runs before parsing; touching a null root would
      // throw and abort installation, the hazard the spec's rootObserver fallback guards).
      // DIAG_SCAN=0 omits it, to prove the old-read failures are the helper's own race and not
      // an artifact of the scan's forced layout.
      w.__firstVisible = null;
      const scan = () => {
        const h1 = document.querySelector('h1');
        if (h1 !== null && h1.getBoundingClientRect().width > 0) {
          w.__firstVisible = {
            at: performance.now(),
            fcp: probe.fcp,
            timeline: performance.getEntriesByName('first-contentful-paint').length,
          };
          return;
        }
        requestAnimationFrame(scan);
      };
      if (scanEnabledParam) requestAnimationFrame(scan);

      const record = () => {
        probe.events.push({
          value: document.documentElement?.dataset['theme'] ?? null,
          time: performance.now(),
        });
      };
      const root = document.documentElement;
      if (root !== null) {
        new MutationObserver(record).observe(root, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
      } else {
        const rootObserver = new MutationObserver(() => {
          const next = document.documentElement;
          if (next === null) return;
          rootObserver.disconnect();
          new MutationObserver(record).observe(next, {
            attributes: true,
            attributeFilter: ['data-theme'],
          });
        });
        rootObserver.observe(document, { childList: true });
      }
      record();
    }, scanEnabled);

    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: 'light' });

    await page.goto(APP);
    // The OLD helper's exact read timing: heading visible -> read probe.fcp with no wait.
    const lagStart = Date.now();
    await page.getByRole('heading', { level: 1, name: 'Today', exact: true }).waitFor({
      state: 'visible',
    });
    const immediate = await page.evaluate(() => ({
      fcp: window.__themeProbe?.fcp ?? null,
      firstVisible: window.__firstVisible ?? null,
    }));
    readLags.push(Date.now() - lagStart);
    if (immediate.firstVisible !== null && immediate.firstVisible.fcp === null) {
      redAtFirstVisible++;
    }
    if (immediate.fcp === null) redAtOldRead++; // the CI assertion at :114 would fire HERE

    // The race window: first layout-visible -> fcp delivered.
    await page.waitForFunction(() => window.__themeProbe?.fcp != null, null, { timeout: 30_000 });
    const waited = await page.evaluate(() => ({
      fcp: window.__themeProbe?.fcp ?? null,
      painted: window.__themeProbe?.events.find((e) => e.value !== null) ?? null,
      firstVisible: window.__firstVisible ?? null,
    }));
    if (waited.fcp === null) waitedNulls++;
    if (waited.fcp !== null && waited.painted !== null && waited.painted.time > waited.fcp) {
      orderingViolations++;
    }
    if (waited.firstVisible !== null && waited.fcp !== null) {
      windows.push(waited.fcp - waited.firstVisible.at);
    }

    await context.close();
  }

  await browser.close();
} finally {
  for (const hog of hogs) hog.kill('SIGKILL');
}

windows.sort((a, b) => a - b);
readLags.sort((a, b) => a - b);
const pct = (arr, p) =>
  arr.length === 0
    ? 'n/a'
    : String(arr[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))]);
console.log(
  `chromium, ${ITERATIONS} fresh-profile first loads (explicit dark, OS light), host load loops: ${LOAD_LOOPS}`,
);
console.log(
  `  RED  hazard on every load: FCP absent at the first layout-visible instant (pre-paint rAF) in ${redAtFirstVisible}/${ITERATIONS}`,
);
console.log(
  `  RED  old helper read semantics (visible -> read, no wait) saw fcp===null in ${redAtOldRead}/${ITERATIONS} — these loads fail theme-boot:114 as in run 40250045123`,
);
console.log(
  `       race window (first-visible -> fcp delivered): min ${windows[0] ?? 'n/a'} ms / p50 ${pct(windows, 0.5)} ms / max ${windows[windows.length - 1] ?? 'n/a'} ms`,
);
console.log(
  `       old read round trip (heading visible -> evaluate returned): min ${readLags[0] ?? 'n/a'} ms / p50 ${pct(readLags, 0.5)} ms / max ${readLags[readLags.length - 1] ?? 'n/a'} ms`,
);
console.log(
  `  GREEN fixed helper read semantics (waitForFunction on fcp): fcp===null in ${waitedNulls}/${ITERATIONS}; theme-before-FCP ordering violations ${orderingViolations}`,
);
