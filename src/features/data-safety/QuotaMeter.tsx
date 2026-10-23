/**
 * `<QuotaMeter>` (design §5.2) — the §4.3 "Storage in this browser" bar.
 *
 * Presentational: it owns no data and emits nothing. The value line under the bar carries the
 * meaning (`role="meter"` + visible text), the bar itself is decoration (§4.4), and the tier
 * label is never colour-only — every tier ships its own words (§2, WCAG 1.4.1).
 *
 * States: `ok | warn | crit | unknown | loading` (§10.2). `totalBytes: null` means the browser
 * reported no total (or `estimate()` is missing entirely — §9.4), which renders the hatched
 * `unknown` track rather than an empty bar that would read as "0% full".
 */

import type { JSX } from 'preact';

import { formatBytes, formatTotal, percentOf } from './format';
import { QUOTA_CRIT_RATIO, QUOTA_WARN_RATIO } from './constants';

export type QuotaTier = 'ok' | 'warn' | 'crit' | 'unknown' | 'loading';

export interface QuotaMeterProps {
  readonly usedBytes: number;
  /** `null` → indeterminate state (§5.2). */
  readonly totalBytes: number | null;
  readonly thresholdWarn?: number;
  readonly thresholdCrit?: number;
  readonly labels: {
    readonly ok?: string | undefined;
    readonly warn: string;
    readonly crit: string;
    readonly unknown: string;
  };
  /** First estimate still in flight (§10.2 `loading`). */
  readonly loading?: boolean;
  /** Value line prefix pieces, so callers can localize "{used} of {total} ({percent}%)". */
  readonly valueTemplate?: (parts: { used: string; total: string; percent: number }) => string;
}

/** Which tier a used/total pair falls into (§4.3 thresholds). */
export function quotaTier(
  usedBytes: number,
  totalBytes: number | null,
  warn: number = QUOTA_WARN_RATIO,
  crit: number = QUOTA_CRIT_RATIO,
): Exclude<QuotaTier, 'loading'> {
  const percent = percentOf(usedBytes, totalBytes);
  if (percent === null) return 'unknown';
  if (percent >= crit * 100) return 'crit';
  if (percent >= warn * 100) return 'warn';
  return 'ok';
}

function defaultValue(parts: { used: string; total: string; percent: number }): string {
  return `${parts.used} of ${parts.total} (${String(parts.percent)}%)`;
}

export function QuotaMeter({
  usedBytes,
  totalBytes,
  thresholdWarn = QUOTA_WARN_RATIO,
  thresholdCrit = QUOTA_CRIT_RATIO,
  labels,
  loading = false,
  valueTemplate = defaultValue,
}: QuotaMeterProps): JSX.Element {
  const tier: QuotaTier =
    loading && totalBytes === null
      ? 'loading'
      : quotaTier(usedBytes, totalBytes, thresholdWarn, thresholdCrit);
  const percent = percentOf(usedBytes, totalBytes);
  const known = totalBytes !== null && percent !== null;

  const statusLabel =
    tier === 'loading'
      ? labels.unknown
      : tier === 'unknown'
        ? labels.unknown
        : tier === 'crit'
          ? labels.crit
          : tier === 'warn'
            ? labels.warn
            : (labels.ok ?? '');

  // §4.3: under 50% the number already speaks (ok tier hidden); warn/crit always show their
  // tier text; unknown/loading say it exactly once, through the value line.
  const showStatus = tier === 'warn' || tier === 'crit' || (tier === 'ok' && (percent ?? 0) >= 50);

  const valueText = known
    ? valueTemplate({
        used: formatBytes(usedBytes),
        total: formatTotal(totalBytes),
        percent,
      })
    : labels.unknown;

  return (
    <div class="quota-meter" data-tier={tier}>
      <div
        class="quota-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? 0}
        aria-valuetext={valueText}
        aria-label={valueText}
      >
        <div
          class="quota-fill"
          style={{ width: known ? `${String(Math.max(percent, 1))}%` : '100%' }}
        />
      </div>
      <p class="quota-value">{valueText}</p>
      {showStatus ? <p class="quota-status">{statusLabel}</p> : null}
    </div>
  );
}
