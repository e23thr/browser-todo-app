/**
 * Structured local error log (ADR-002 §10.4): every error branch writes a JSON
 * ring-buffer entry — downloadable, never telemetry (§7.2). Repos and the
 * domain pipeline record here; the storage dashboard (S11) surfaces it.
 */

import type { AppError } from '../domain/kernel';

export type ErrorLogEntry = {
  at: number;
  layer: 'storage' | 'repos' | 'domain';
  op: string;
  error: unknown;
  detail?: string;
};

export type ErrorLog = {
  record(entry: Omit<ErrorLogEntry, 'at'> & { at?: number }): void;
  list(): readonly ErrorLogEntry[];
  clear(): void;
  download(): { filename: string; json: string };
};

const DEFAULT_CAPACITY = 100;

export function createErrorLog(options: { capacity?: number; now?: () => number } = {}): ErrorLog {
  const capacity = Math.max(1, options.capacity ?? DEFAULT_CAPACITY);
  const now = options.now ?? Date.now;
  const entries: ErrorLogEntry[] = [];
  return {
    record(entry) {
      entries.push({ at: entry.at ?? now(), ...entry });
      if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    },
    list() {
      return [...entries];
    },
    clear() {
      entries.length = 0;
    },
    download() {
      const stamp = new Date(now()).toISOString().replace(/[:.]/gu, '-');
      return {
        filename: `local-first-todo-errors-${stamp}.json`,
        json: JSON.stringify({ format: 'local-first-todo-errors', entries }, null, 2),
      };
    },
  };
}

/** Module-level ring buffer used when no log is injected. */
export const defaultErrorLog: ErrorLog = createErrorLog();

/** Narrow helper so adapters record typed errors without leaking shapes. */
export function logAppError(
  log: ErrorLog | undefined,
  layer: ErrorLogEntry['layer'],
  op: string,
  error: AppError,
  detail?: string,
): void {
  log?.record(detail === undefined ? { layer, op, error } : { layer, op, error, detail });
}
