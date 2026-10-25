#!/usr/bin/env node
/**
 * Perf budget gate — ADR-001 §8, PROJECT_ANALYSIS.md §9.1 (t_7c1b251b).
 *
 * The measured-perf half of the DoD line "budgets green in CI", mirroring the §9.2 bundle gate
 * (scripts/check-bundle-budget.mjs): thresholds live in scripts/perf-budgets.json (single source
 * of truth) and this script only measures, enforces and reports.
 *
 * How it runs (per preset — mobile is the §9.1 condition: slow 4G + 4× CPU; desktop is the
 * second CI profile):
 *   1. `lhci collect` — Lighthouse through Lighthouse CI against the built dist/, served by
 *      `vite preview` under the same BASE_PATH as the deploy (config: lighthouserc.cjs).
 *   2. `lhci assert`   — the hard DoD thresholds (LCP ≤ 2500 ms, TBT ≤ 200 ms, CLS ≤ 0.1) as
 *      `error` assertions on the median run; a violation fails this script (exit 1).
 *   3. archive every LHR to lighthouse-reports/<preset>/ (CI uploads them as artifacts) and
 *      summarize the metrics here, including §9.1's stricter recommended line (LCP < 1500 ms),
 *      which is WARN + a GitHub annotation only — non-blocking until mobile LCP is under 1.5 s.
 *
 * Usage:
 *   node scripts/check-perf-budget.mjs [--preset <name>] [--budgets <file>] [--json]
 *
 * Runs from the repo root (it needs dist/, lighthouserc.cjs and node_modules). Chrome is found
 * by chrome-launcher (preinstalled Google Chrome on GitHub-hosted runners); set CHROME_PATH
 * where no system Chrome exists (e.g. Playwright's Chromium).
 *
 * Exit codes: 0 = every hard gate passes (warnings allowed), 1 = a hard gate fails,
 * 2 = the gates could not run (missing dist/, Lighthouse/collect failure).
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import process from 'node:process';

const DEFAULT_BUDGETS = new URL('./perf-budgets.json', import.meta.url);
const LHCI_DIR = '.lighthouseci';
const REPORTS_DIR = 'lighthouse-reports';
/** Lighthouse CI names saved reports `lhr-<timestamp>.json` (@lhci/utils saved-reports.js). */
const LHR_REGEX = /^lhr-\d+\.json$/;

/** @param {number[]} values */
function median(values) {
  if (values.length === 0) throw new Error('median() needs at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor((sorted.length - 1) / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle] + sorted[middle + 1]) / 2;
}

/** @param {number} limit @param {string} unit */
function formatLimit(limit, unit) {
  return unit === 'ms' ? `${limit} ms` : String(limit);
}

/** @param {number} value @param {'ms' | 'score'} unit */
function formatValue(value, unit) {
  return unit === 'ms' ? `${value.toFixed(1)} ms` : value.toFixed(3);
}

/**
 * Evaluate every §9.1 gate for every preset from the collected Lighthouse reports.
 *
 * Aggregation mirrors `assert.aggregationMethod` in lighthouserc.cjs: the median run, so one
 * outlier neither fails the build nor hides a warning. A metric missing from the reports is a
 * FAIL — a gate that cannot measure must not pass silently.
 *
 * @param {{ runsByPreset: Record<string, any[]>, budgets: any }} input
 */
export function evaluatePerfBudget({ runsByPreset, budgets }) {
  const aggregation = budgets.collect?.aggregationMethod ?? 'median';
  const gates = Object.entries(budgets.gates);

  const budgetPresets = Object.keys(budgets.collect?.presets ?? {});
  const presets = [
    ...budgetPresets.filter((name) => runsByPreset[name] !== undefined),
    ...Object.keys(runsByPreset).filter((name) => !budgetPresets.includes(name)),
  ];

  /** @type {any[]} */
  const results = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, number>} */
  const runsPerPreset = {};

  for (const preset of presets) {
    const lhrs = runsByPreset[preset] ?? [];
    runsPerPreset[preset] = lhrs.length;

    for (const [gate, config] of gates) {
      const auditId = config.auditId;
      const unit = config.unit === 'score' ? 'score' : 'ms';
      const values = lhrs
        .map((lhr) => lhr?.audits?.[auditId]?.numericValue)
        .filter((value) => typeof value === 'number' && Number.isFinite(value));
      const measured = values.length > 0 ? median(values) : null;
      const status = measured === null || measured > config.limit ? 'FAIL' : 'PASS';
      const recommended =
        typeof config.recommended === 'number' && measured !== null ? config.recommended : null;
      const recommendedStatus =
        recommended === null ? null : measured >= recommended ? 'WARN' : 'PASS';

      const detail =
        measured === null
          ? `${auditId} missing from ${lhrs.length} LHR run(s)`
          : `median of ${values.length} run(s)`;

      results.push({
        preset,
        gate,
        auditId,
        unit,
        measured,
        limit: config.limit,
        status,
        recommended,
        recommendedStatus,
        runs: values.length,
        detail,
      });

      if (recommendedStatus === 'WARN') {
        warnings.push(
          `${preset} ${gate.toUpperCase()} ${formatValue(measured, unit)} >= ` +
            `${formatLimit(recommended, unit)} — §9.1 recommended line (non-blocking)`,
        );
      }
    }
  }

  return {
    ok: results.every((result) => result.status === 'PASS'),
    presets,
    runsPerPreset,
    aggregation,
    results,
    warnings,
  };
}

/** @param {any} report */
export function formatPerfReport(report) {
  const pad = (value, width) => String(value).padEnd(width);
  const runCounts = Object.entries(report.runsPerPreset)
    .map(([preset, count]) => `${preset} ${count}`)
    .join(', ');

  const lines = [];
  lines.push(
    `Perf budget report — §9.1 LCP/TBT/CLS (${report.aggregation} of runs; runs: ${runCounts})`,
  );
  lines.push(
    `  ${pad('preset', 9)}${pad('gate', 5)}${pad('measured', 12)}${pad('limit', 10)}${pad('status', 7)}note`,
  );
  for (const result of report.results) {
    const measured = result.measured === null ? 'n/a' : formatValue(result.measured, result.unit);
    const limit = formatLimit(result.limit, result.unit);
    let note = result.detail;
    if (result.status === 'FAIL') {
      note = result.detail;
    } else if (result.recommendedStatus === 'WARN') {
      note = `§9.1 recommended < ${formatLimit(result.recommended, result.unit)} — WARN (non-blocking)`;
    }
    lines.push(
      `  ${pad(result.preset, 9)}${pad(result.gate, 5)}${pad(measured, 12)}${pad(limit, 10)}${pad(result.status, 7)}${note}`,
    );
  }
  if (report.warnings.length > 0) {
    lines.push('Non-blocking warnings (§9.1 recommended line):');
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }
  lines.push(
    report.ok
      ? `RESULT: PASS — every §9.1 hard gate is green (${report.warnings.length} non-blocking warning(s))`
      : `RESULT: FAIL — ${report.results.filter((result) => result.status === 'FAIL').length} gate(s) over the §9.1 DoD threshold`,
  );
  return lines.join('\n');
}

/** Read every saved Lighthouse report in `.lighthouseci` as JSON. */
function loadLhrs() {
  if (!existsSync(LHCI_DIR)) return [];
  /** @type {any[]} */
  const lhrs = [];
  for (const file of readdirSync(LHCI_DIR)) {
    if (!LHR_REGEX.test(file)) continue;
    try {
      lhrs.push(JSON.parse(readFileSync(join(LHCI_DIR, file), 'utf8')));
    } catch {
      // A truncated report must not be treated as a measurement — collect already failed loudly.
    }
  }
  return lhrs;
}

/**
 * Move this preset's saved reports into lighthouse-reports/<preset>/ (the CI artifact) and
 * return the parsed LHRs. `.lighthouseci` is cleared by the next `lhci collect`.
 */
function archiveLhrs(preset) {
  const target = join(REPORTS_DIR, preset);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const file of existsSync(LHCI_DIR) ? readdirSync(LHCI_DIR) : []) {
    if (LHR_REGEX.test(file) || file === 'assertion-results.json') {
      copyFileSync(join(LHCI_DIR, file), join(target, file));
    }
  }
  return loadLhrs();
}

/**
 * Run an Lighthouse CI subcommand with the rc file pinned and the preset selected.
 *
 * @param {string[]} args
 * @param {string} preset
 * @param {Record<string, string>} [extraEnv]
 * @returns {number} exit status (0 = passed)
 */
function runLhci(args, preset, extraEnv = {}) {
  const result = spawnSync('npx', ['lhci', ...args, '--config', 'lighthouserc.cjs'], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, PERF_PRESET: preset, ...extraEnv },
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined && result.error !== null) {
    console.error(`perf-budget: could not run lhci ${args[0]}: ${result.error.message}`);
    return 2;
  }
  return result.status ?? 1;
}

/** @param {any} report */
function announceWarnings(report) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  for (const warning of report.warnings) {
    // GitHub workflow command: surfaces the non-blocking line on the run's annotation list.
    console.log(`::warning title=§9.1 recommended LCP line::${warning}`);
  }
}

/** @param {any} report @param {{tool: Record<string, string>, subject: Record<string, any>}} meta */
function appendStepSummary(report, meta) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === '') return;

  const rows = report.results
    .map((result) => {
      const measured = result.measured === null ? 'n/a' : formatValue(result.measured, result.unit);
      const recommended =
        result.recommended === null
          ? '—'
          : result.recommendedStatus === 'WARN'
            ? `WARN (< ${formatLimit(result.recommended, result.unit)})`
            : 'ok';
      return `| ${result.preset} | ${result.gate.toUpperCase()} | ${measured} | ${formatLimit(result.limit, result.unit)} | ${result.status} | ${recommended} |`;
    })
    .join('\n');

  const text = [
    '### §9.1 perf budget — Lighthouse CI',
    '',
    `${meta.subject} — ${meta.tool}`,
    '',
    '| preset | gate | measured | limit | status | §9.1 recommended |',
    '| --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    report.ok
      ? `**RESULT: PASS** (${report.warnings.length} non-blocking warning(s)) — full reports in the \`lighthouse-reports\` artifact.`
      : '**RESULT: FAIL** — a §9.1 DoD threshold was exceeded.',
    '',
  ].join('\n');

  try {
    appendFileSync(summaryPath, text);
  } catch (error) {
    console.warn(`perf-budget: could not write the step summary: ${String(error)}`);
  }
}

function parseArgs(argv) {
  const options = { presets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--preset') {
      options.presets.push(argv[i + 1]);
      i += 1;
    } else if (arg === '--budgets') {
      options.budgetsPath = argv[i + 1];
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.presets.some((preset) => preset === undefined)) {
    throw new Error('--preset needs a preset name');
  }
  return options;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const budgetsPath = options.budgetsPath ?? fileURLToPath(DEFAULT_BUDGETS);
    const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
    // Keep lighthouserc.cjs asserting the very thresholds this script summarizes (see --budgets).
    const budgetsEnv = { PERF_BUDGETS_PATH: resolve(budgetsPath) };

    if (!existsSync(join('dist', 'index.html'))) {
      throw new Error('dist/index.html not found — run `npm run build` first');
    }

    const presets =
      options.presets.length > 0 ? options.presets : Object.keys(budgets.collect.presets);

    /** @type {Record<string, any[]>} */
    const runsByPreset = {};
    let collectFailed = false;
    let assertFailed = false;

    for (const preset of presets) {
      console.log(`\n=== perf-budget: ${preset} preset — lhci collect ===`);
      const collectStatus = runLhci(['collect'], preset, budgetsEnv);
      if (collectStatus !== 0) {
        console.error(`perf-budget: lhci collect failed for the ${preset} preset`);
        collectFailed = true;
        continue;
      }
      console.log(`=== perf-budget: ${preset} preset — lhci assert (hard §9.1 gates) ===`);
      const assertStatus = runLhci(['assert'], preset, budgetsEnv);
      if (assertStatus !== 0) assertFailed = true;

      // Archive after `lhci assert`, so this preset's assertion-results.json is captured too —
      // the next preset's `lhci collect` clears `.lighthouseci` unconditionally.
      runsByPreset[preset] = archiveLhrs(preset);
    }

    if (Object.keys(runsByPreset).length === 0) {
      console.error('perf-budget: no Lighthouse reports were collected');
      process.exit(2);
    }

    const report = evaluatePerfBudget({ runsByPreset, budgets });
    const tool = {
      lighthouseCi: '@lhci/cli',
      lighthouse:
        JSON.parse(readFileSync(join('node_modules', 'lighthouse', 'package.json'), 'utf8'))
          .version ?? 'unknown',
      aggregation: report.aggregation,
    };
    const summary = {
      generatedAt: new Date().toISOString(),
      tool,
      subject: 'dist served by `vite preview` under BASE_PATH ' + (process.env.BASE_PATH ?? '/'),
      thresholds: budgets.gates,
      presets: report.presets,
      runsPerPreset: report.runsPerPreset,
      results: report.results,
      warnings: report.warnings,
      collectFailed,
      assertFailed,
      ok: report.ok && !assertFailed && !collectFailed,
    };

    mkdirSync(REPORTS_DIR, { recursive: true });
    const summaryPath = join(REPORTS_DIR, 'perf-budget-summary.json');
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\nWrote ${summaryPath}`);

    if (options.json === true) console.log(JSON.stringify(summary, null, 2));
    else console.log(`\n${formatPerfReport(report)}`);

    announceWarnings(report);
    appendStepSummary(report, {
      tool: `Lighthouse ${tool.lighthouse} via @lhci/cli — ${report.aggregation} of ${String(report.runsPerPreset[report.presets[0]] ?? 0)} run(s)/preset`,
      subject: summary.subject,
    });

    process.exitCode = summary.ok ? 0 : 1;
    if (collectFailed) process.exitCode = 2;
  } catch (error) {
    console.error(`perf-budget: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
