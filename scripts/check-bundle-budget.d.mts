/** Type surface for scripts/check-bundle-budget.mjs (kept beside the script so tests stay typed). */

export interface GateResult {
  readonly name: string;
  readonly kind: 'size' | 'count';
  readonly measuredBytes: number;
  readonly limitBytes: number;
  readonly warnBytes: number | null;
  readonly status: 'PASS' | 'WARN' | 'FAIL';
  readonly detail: string;
}

export interface BudgetReportContext {
  readonly initialJsFiles: string[];
  readonly cssFiles: string[];
  readonly shellFiles: string[];
  readonly lazyFiles: string[];
  readonly locales: string[];
  readonly serviceWorkerFiles: string[];
  readonly measured: Record<string, number>;
}

export interface BudgetReport {
  readonly ok: boolean;
  readonly distDir: string;
  readonly manifestEntries: number;
  readonly results: GateResult[];
  readonly context: BudgetReportContext;
}

export function evaluateBundleBudget(input: {
  readonly distDir: string;
  readonly budgets: unknown;
}): BudgetReport;

export function formatReport(report: BudgetReport): string;

export function checkBundleBudget(options?: {
  readonly distDir?: string;
  readonly budgetsPath?: string;
}): { readonly report: BudgetReport; readonly text: string; readonly json: string };
