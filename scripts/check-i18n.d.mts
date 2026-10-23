/** Type surface for scripts/check-i18n.mjs (kept beside the script so tests stay typed). */

export type I18nIssueKind =
  | 'duplicate-key'
  | 'bad-key'
  | 'missing-in-th'
  | 'extra-in-th'
  | 'non-string-value'
  | 'empty-value'
  | 'placeholder-mismatch'
  | 'unknown-key';

export interface I18nIssue {
  readonly kind: I18nIssueKind;
  readonly detail: string;
}

export interface I18nStats {
  readonly enKeys: number;
  readonly thKeys: number;
  readonly usedKeys: number;
  readonly literalCallSites: number;
  readonly dynamicCallSites: readonly string[];
}

export interface I18nReport {
  readonly ok: boolean;
  readonly issues: readonly I18nIssue[];
  readonly stats: I18nStats;
}

export interface KeyUsages {
  readonly literal: Set<string>;
  readonly dynamic: number[];
}

export const KEY_PATTERN: RegExp;

export function findDuplicateKeys(raw: string): string[];
export function placeholdersOf(text: string): Set<string>;
export function findKeyUsages(source: string): KeyUsages;
export function compareCatalogs(
  en: Record<string, unknown>,
  th: Record<string, unknown>,
): I18nIssue[];
export function checkI18n(options?: {
  readonly enPath?: string;
  readonly thPath?: string;
  readonly srcDir?: string;
}): I18nReport;
export function formatReport(report: I18nReport): string;
