'use strict';

/**
 * Lighthouse CI configuration — the section 9.1 perf-budget gate (CI job `perf-budget`).
 *
 * Thresholds come from scripts/perf-budgets.json, the single source shared with
 * scripts/check-perf-budget.mjs, so a budget change is a one-file diff (the same arrangement
 * as the section 9.2 bundle gate's scripts/bundle-budgets.json).
 *
 * One Lighthouse preset per invocation: `PERF_PRESET` picks `mobile` (default — the section 9.1
 * measurement condition: simulated slow 4G + 4x CPU) or `desktop`; the runner script drives both
 * and archives every LHR. The subject is the CI `dist` artifact, served by `vite preview` under
 * the same BASE_PATH the deploy uses, so the measured build is the shipped build.
 *
 * The DoD thresholds are asserted as `error` (they fail the job). Section 9.1's stricter
 * recommended line (LCP < 1500 ms) is held non-blocking by scripts/check-perf-budget.mjs as a
 * WARN + GitHub annotation, because LHCI allows exactly one assertion level per audit — so a
 * second level for `largest-contentful-paint` cannot be expressed here.
 *
 * Chrome resolution: chrome-launcher finds the preinstalled Google Chrome on GitHub-hosted
 * ubuntu runners; set CHROME_PATH where no system Chrome exists (e.g. Playwright's Chromium).
 */

// `PERF_BUDGETS_PATH` (exported by scripts/check-perf-budget.mjs when `--budgets` is used) keeps
// the assertions and the summary on the same thresholds; a './…' path resolves against this file.
const budgets = require(process.env.PERF_BUDGETS_PATH || './scripts/perf-budgets.json');

/** @param {string | undefined} raw */
function normalizeBase(raw) {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '/' || raw.trim() === './') {
    return '/';
  }
  const trimmed = raw.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

const presetNames = Object.keys(budgets.collect.presets);
// NB: the variable must NOT start with `LHCI_` — Lighthouse CI maps `LHCI_<option>` onto its own
// yargs options (`LHCI_PRESET` would hit `assert --preset`, which only accepts the
// lighthouse:* presets and aborts the run).
const presetName = process.env.PERF_PRESET || 'mobile';
const preset = budgets.collect.presets[presetName];
if (preset === undefined) {
  throw new Error(`PERF_PRESET must be one of: ${presetNames.join(', ')} (got "${presetName}")`);
}

const port = Number(process.env.PERF_PORT || 4173);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`PERF_PORT must be a valid port number (got "${String(process.env.PERF_PORT)}")`);
}

const url = `http://127.0.0.1:${port}${normalizeBase(process.env.BASE_PATH)}`;

// Chrome's sandbox cannot start where AppArmor forbids unprivileged user namespaces (Ubuntu
// 23.10+/24.04 defaults and most CI containers) — Lighthouse then dies with "No usable
// sandbox!". Playwright launches Chromium without its sandbox for the same reason (its
// `chromiumSandbox` default is false), so the gate matches the browser the E2E suite runs.
// Override with PERF_CHROME_FLAGS when a runner can take the sandbox (e.g. '' to keep it).
const chromeFlags = process.env.PERF_CHROME_FLAGS ?? '--no-sandbox';

/** @type {Record<string, ['error', {maxNumericValue: number}]>} */
const assertions = {};
for (const gate of Object.values(budgets.gates)) {
  assertions[gate.auditId] = ['error', { maxNumericValue: gate.limit }];
}

module.exports = {
  ci: {
    collect: {
      numberOfRuns: budgets.collect.numberOfRuns,
      url,
      // `vite preview` honours BASE_PATH, so the Pages base path is exercised, not bypassed.
      startServerCommand: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
      // LHCI's default ready pattern is `listen|ready`, but a non-TTY `vite preview` prints only
      // its `➜ Local: <url>` line — so match that too, and allow a cold `npx` to boot within it.
      startServerReadyPattern: 'Local:|ready|listen',
      startServerReadyTimeout: 60_000,
      // {} = Lighthouse's default mobile config (the section 9.1 condition); `desktop` preset
      // otherwise — both described in scripts/perf-budgets.json.
      settings: { ...preset.settings, chromeFlags },
    },
    assert: {
      assertions,
      aggregationMethod: budgets.collect.aggregationMethod,
      includePassedAssertions: true,
    },
  },
};
