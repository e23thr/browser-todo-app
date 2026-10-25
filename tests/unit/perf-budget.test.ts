import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluatePerfBudget,
  formatPerfReport,
  type LhrLike,
} from '../../scripts/check-perf-budget.mjs';

/**
 * §9.1 measured-perf half of "budgets green in CI" (t_7c1b251b). The gate must be able to
 * fail — "a gate that never fails is a defect" (§9.2/§9.5) — so every threshold is proven
 * here with synthetic Lighthouse reports, including the median aggregation and the
 * non-blocking §9.1 recommended line.
 *
 * Thresholds are read from scripts/perf-budgets.json (the single source the CI job enforces),
 * never re-typed, so these tests fail if the config drifts from the DoD lines.
 */

const budgetsPath = join(process.cwd(), 'scripts', 'perf-budgets.json');
const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8')) as unknown;

interface Metrics {
  readonly lcp?: number;
  readonly tbt?: number;
  readonly cls?: number;
}

function lhr(metrics: Metrics): LhrLike {
  const audits: LhrLike['audits'] = {
    'largest-contentful-paint': { numericValue: 0 },
    'total-blocking-time': { numericValue: 0 },
    'cumulative-layout-shift': { numericValue: 0 },
  };
  if (metrics.lcp !== undefined) audits['largest-contentful-paint'] = { numericValue: metrics.lcp };
  if (metrics.tbt !== undefined) audits['total-blocking-time'] = { numericValue: metrics.tbt };
  if (metrics.cls !== undefined) audits['cumulative-layout-shift'] = { numericValue: metrics.cls };
  return { audits };
}

/** A green pair of presets at the measured reference values (mobile slow-4G, desktop). */
function referenceRuns(): Record<string, LhrLike[]> {
  return {
    mobile: [
      lhr({ lcp: 1623.6, tbt: 8.5, cls: 0 }),
      lhr({ lcp: 1610.2, tbt: 7.1, cls: 0 }),
      lhr({ lcp: 1640.8, tbt: 9.4, cls: 0 }),
    ],
    desktop: [lhr({ lcp: 285.6, tbt: 0, cls: 0 }), lhr({ lcp: 291.1, tbt: 0, cls: 0 })],
  };
}

function statusOf(
  report: ReturnType<typeof evaluatePerfBudget>,
  preset: string,
  gate: string,
): string {
  const result = report.results.find((entry) => entry.preset === preset && entry.gate === gate);
  if (result === undefined) throw new Error(`no gate named ${gate} for preset ${preset}`);
  return result.status;
}

function resultOf(report: ReturnType<typeof evaluatePerfBudget>, preset: string, gate: string) {
  const result = report.results.find((entry) => entry.preset === preset && entry.gate === gate);
  if (result === undefined) throw new Error(`no gate named ${gate} for preset ${preset}`);
  return result;
}

describe('perf budget gate — within-budget runs', () => {
  it('passes both presets and reports every §9.1 gate per preset', () => {
    const report = evaluatePerfBudget({ runsByPreset: referenceRuns(), budgets });

    expect(report.ok).toBe(true);
    expect(report.presets).toEqual(['mobile', 'desktop']);
    expect(report.results.map((entry) => `${entry.preset}:${entry.gate}`)).toEqual([
      'mobile:lcp',
      'mobile:tbt',
      'mobile:cls',
      'desktop:lcp',
      'desktop:tbt',
      'desktop:cls',
    ]);
    expect(report.results.every((entry) => entry.status === 'PASS')).toBe(true);
    expect(formatPerfReport(report)).toContain('RESULT: PASS');
  });

  it('takes the threshold from perf-budgets.json rather than a hard-coded number', () => {
    const report = evaluatePerfBudget({ runsByPreset: referenceRuns(), budgets });
    const lcp = resultOf(report, 'mobile', 'lcp');

    expect(lcp.limit).toBe(2500);
    expect(resultOf(report, 'mobile', 'tbt').limit).toBe(200);
    expect(resultOf(report, 'mobile', 'cls').limit).toBe(0.1);
    expect(lcp.recommended).toBe(1500);
    expect(resultOf(report, 'mobile', 'tbt').recommended).toBeNull();
  });

  it('warns (but never fails) on the §9.1 recommended LCP line alone', () => {
    const report = evaluatePerfBudget({ runsByPreset: referenceRuns(), budgets });
    const lcp = resultOf(report, 'mobile', 'lcp');

    expect(lcp.status).toBe('PASS');
    expect(lcp.recommendedStatus).toBe('WARN');
    expect(report.ok).toBe(true);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('1500');
    expect(formatPerfReport(report)).toContain('RESULT: PASS');
  });

  it('treats an LCP exactly on the recommended line as over (the line is "< 1.5 s")', () => {
    const runs = referenceRuns();
    runs['mobile'] = [lhr({ lcp: 1500, tbt: 5, cls: 0 })];
    const report = evaluatePerfBudget({ runsByPreset: runs, budgets });

    expect(resultOf(report, 'mobile', 'lcp').recommendedStatus).toBe('WARN');
    expect(report.ok).toBe(true);
  });
});

describe('perf budget gate — deliberate violations (hard DoD lines)', () => {
  it('FAILS when median LCP exceeds 2500 ms, and passes exactly at 2500 ms', () => {
    const over = referenceRuns();
    over['mobile'] = [lhr({ lcp: 2500.1, tbt: 5, cls: 0 })];
    const atLine = referenceRuns();
    atLine['mobile'] = [lhr({ lcp: 2500, tbt: 5, cls: 0 })];

    const overReport = evaluatePerfBudget({ runsByPreset: over, budgets });
    const atLineReport = evaluatePerfBudget({ runsByPreset: atLine, budgets });

    expect(statusOf(overReport, 'mobile', 'lcp')).toBe('FAIL');
    expect(overReport.ok).toBe(false);
    expect(formatPerfReport(overReport)).toContain('RESULT: FAIL');
    expect(statusOf(atLineReport, 'mobile', 'lcp')).toBe('PASS');
    expect(atLineReport.ok).toBe(true);
  });

  it('FAILS when median TBT exceeds 200 ms and when median CLS exceeds 0.1', () => {
    const tbtRuns = referenceRuns();
    tbtRuns['desktop'] = [lhr({ lcp: 286, tbt: 201, cls: 0 })];
    const clsRuns = referenceRuns();
    clsRuns['desktop'] = [lhr({ lcp: 286, tbt: 0, cls: 0.11 })];

    const tbtReport = evaluatePerfBudget({ runsByPreset: tbtRuns, budgets });
    const clsReport = evaluatePerfBudget({ runsByPreset: clsRuns, budgets });

    expect(statusOf(tbtReport, 'desktop', 'tbt')).toBe('FAIL');
    expect(tbtReport.ok).toBe(false);
    expect(statusOf(clsReport, 'desktop', 'cls')).toBe('FAIL');
    expect(clsReport.ok).toBe(false);
  });

  it('FAILS (never silently passes) when a metric is missing from the report', () => {
    const runs = referenceRuns();
    runs['mobile'] = [{ audits: { 'largest-contentful-paint': { scoreDisplayMode: 'error' } } }];
    const report = evaluatePerfBudget({ runsByPreset: runs, budgets });
    const lcp = resultOf(report, 'mobile', 'lcp');

    expect(lcp.status).toBe('FAIL');
    expect(lcp.measured).toBeNull();
    expect(lcp.detail).toContain('missing');
    expect(report.ok).toBe(false);
  });
});

describe('perf budget gate — aggregation across runs', () => {
  it('gates on the median run, not on the best or the worst run', () => {
    const runs = referenceRuns();
    // min 900 (would hide the recommended-line warning), median 1600, max 4000 (would fail).
    runs['mobile'] = [
      lhr({ lcp: 900, tbt: 5, cls: 0 }),
      lhr({ lcp: 1600, tbt: 5, cls: 0 }),
      lhr({ lcp: 4000, tbt: 5, cls: 0 }),
    ];
    const report = evaluatePerfBudget({ runsByPreset: runs, budgets });
    const lcp = resultOf(report, 'mobile', 'lcp');

    expect(report.aggregation).toBe('median');
    expect(lcp.measured).toBe(1600);
    expect(lcp.status).toBe('PASS');
    expect(lcp.recommendedStatus).toBe('WARN');
    expect(report.ok).toBe(true);
    expect(lcp.runs).toBe(3);
  });

  it('records the number of runs that contributed to each gate', () => {
    const report = evaluatePerfBudget({ runsByPreset: referenceRuns(), budgets });

    expect(resultOf(report, 'mobile', 'lcp').runs).toBe(3);
    expect(resultOf(report, 'desktop', 'lcp').runs).toBe(2);
  });
});

describe('perf budget gate — report formatting', () => {
  it('prints preset, gate, measured, limit and unit, plus the warning detail', () => {
    const report = evaluatePerfBudget({ runsByPreset: referenceRuns(), budgets });
    const text = formatPerfReport(report);

    expect(text).toContain('mobile');
    expect(text).toContain('desktop');
    expect(text).toContain('2500 ms');
    expect(text).toContain('200 ms');
    expect(text).toContain('0.1');
    expect(text).toContain('WARN');
    expect(text).toContain('non-blocking');
  });
});
