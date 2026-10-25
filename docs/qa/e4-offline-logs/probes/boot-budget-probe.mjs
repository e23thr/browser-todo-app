/**
 * Independent boot-budget probe (QA card t_be7f0810, epic E4).
 *
 * Measures `app:interactive` (start-to-interactive, PROJECT_ANALYSIS §9.1) on warm (online,
 * service-worker-controlled) and network-disabled reloads of the fixture build, in two modes:
 * unthrottled and 4x CPU throttled (§9.1 budgets are stated for a mid-tier Moto-G-class device
 * with 4x CPU throttle). N samples per mode; results written next to this script.
 *
 * Re-run: `node docs/qa/e4-offline-logs/probes/boot-budget-probe.mjs` (from the repo root).
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { FIXTURES, buildFixtures } from '../../../../tests/e2e/fixtures/build-fixtures.mjs';
import { createStaticServer } from '../../../../tests/e2e/fixtures/static-server.mjs';

const BASE_PATH = '/browser-todo-app/';
const PORT = 4291;
const SAMPLES = 10;
const BUDGET_MS = 300;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, '..', 'boot-budget-results.json');

if (!existsSync(join(FIXTURES.vA, 'index.html'))) {
  buildFixtures({ basePath: BASE_PATH });
}

const server = createStaticServer({ mountPath: BASE_PATH, port: PORT });
server.setRoot(FIXTURES.vA);
await server.listen();
const appUrl = `http://127.0.0.1:${String(PORT)}${BASE_PATH}`;

/** Start-to-interactive (ms since navigation start) once the app recorded its mark. */
async function interactiveMs(page) {
  await page.waitForFunction(() => performance.getEntriesByName('app:interactive').length > 0);
  return page.evaluate(() => performance.getEntriesByName('app:interactive')[0].startTime);
}

const results = [];
const browser = await chromium.launch();
try {
  for (const mode of [
    { name: 'unthrottled', rate: 1 },
    { name: 'cpu-4x', rate: 4 },
  ]) {
    for (let sample = 1; sample <= SAMPLES; sample += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: mode.rate });

      await page.goto(appUrl);
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

      await page.reload();
      const warmMs = await interactiveMs(page);

      await context.setOffline(true);
      await page.reload();
      const offlineMs = await interactiveMs(page);

      results.push({ mode: mode.name, cpuThrottle: mode.rate, sample, warmMs, offlineMs });
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    min: sorted[0],
    median:
      sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted[sorted.length - 1],
  };
};

const summary = {};
for (const mode of ['unthrottled', 'cpu-4x']) {
  const rows = results.filter((row) => row.mode === mode);
  summary[mode] = {
    warm: stats(rows.map((row) => row.warmMs)),
    offline: stats(rows.map((row) => row.offlineMs)),
    withinBudget:
      rows.every((row) => row.warmMs < BUDGET_MS) && rows.every((row) => row.offlineMs < BUDGET_MS),
  };
}

writeFileSync(
  OUTPUT,
  `${JSON.stringify(
    { measuredAt: new Date().toISOString(), budgetMs: BUDGET_MS, samplesPerMode: SAMPLES, summary, results },
    null,
    2,
  )}\n`,
);

process.stdout.write(
  `${JSON.stringify(summary, null, 2)}\nresults: ${resolve(OUTPUT)}\n`,
);
