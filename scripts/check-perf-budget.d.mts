/** Type surface for scripts/check-perf-budget.mjs (kept beside the script so tests stay typed). */

export interface AuditLike {
  readonly numericValue?: number;
  readonly scoreDisplayMode?: string;
}

export interface LhrLike {
  readonly audits: Record<string, AuditLike | undefined>;
}

export interface PerfGateResult {
  readonly preset: string;
  readonly gate: string;
  readonly auditId: string;
  readonly unit: 'ms' | 'score';
  readonly measured: number | null;
  readonly limit: number;
  readonly status: 'PASS' | 'FAIL';
  readonly recommended: number | null;
  readonly recommendedStatus: 'PASS' | 'WARN' | null;
  readonly runs: number;
  readonly detail: string;
}

export interface PerfReport {
  readonly ok: boolean;
  readonly presets: string[];
  readonly runsPerPreset: Record<string, number>;
  readonly aggregation: string;
  readonly results: PerfGateResult[];
  readonly warnings: string[];
}

export function evaluatePerfBudget(input: {
  readonly runsByPreset: Record<string, LhrLike[]>;
  readonly budgets: unknown;
}): PerfReport;

export function formatPerfReport(report: PerfReport): string;
