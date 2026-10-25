/**
 * `SyncEngine` — the Decision 9.2 API the sync UI consumes, plus Decision 9.1
 * scheduling ("Sync now" + periodic-when-online). All results are `Result`
 * (team baseline — nothing throws across this boundary).
 *
 * States (the only four the UI knows): idle / syncing / error /
 * conflicts-pending. `conflicts-pending` is sticky after a run that created
 * conflict copies and clears on `acknowledgeConflicts()`.
 *
 * Opt-in boundary (§6.2): nothing ever touches the network before
 * `configure()` — sync is user-triggered or periodic-when-online, never
 * required for local correctness. Auto-retry backs off 1m → 5m → 30m and NEVER
 * retries `AUTH`/`CONFIG`/`SYNC_FORMAT_NEWER` (no credential guessing).
 */

import { signal, type Signal } from '@preact/signals';

import type { AppDB } from '../storage/db';
import type { ErrorLog } from '../storage/errorLog';
import type { Result } from '../domain/kernel';
import { newUlid } from '../storage/id';
import { ensureSyncState } from '../storage/syncState';
import type { SyncStateRecord } from '../storage/types';
import { runSyncOnce } from './engine';
import type { RunOutcome } from './engine';
import type { ConflictSummary, SyncError, SyncRunPhase, SyncRunSummary, SyncState } from './types';
import { assertSecureRemote, WebDavClient } from './webdav';
import type { FetchLike } from './webdav';

/** Decision 9.1: periodic-when-online interval. */
export const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** Failure backoff: 1 min → 5 min → 30 min cap (reset on success). */
export const BACKOFF_STEPS_MS = [60_000, 5 * 60_000, 30 * 60_000];

export type SchedulerEnv = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  addEventListener: (type: 'online' | 'visibilitychange', fn: () => void) => void;
  removeEventListener: (type: 'online' | 'visibilitychange', fn: () => void) => void;
  isOnline: () => boolean;
  isVisible: () => boolean;
  /** `navigator.connection.saveData` — auto-sync stands down, manual still works. */
  saveData: () => boolean;
};

export function defaultSchedulerEnv(): SchedulerEnv {
  return {
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (handle) => {
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
    },
    addEventListener: (type, fn) => {
      globalThis.addEventListener(type, fn);
    },
    removeEventListener: (type, fn) => {
      globalThis.removeEventListener(type, fn);
    },
    isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
    isVisible: () =>
      typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
    saveData: () =>
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true,
  };
}

export type SyncEngineDeps = {
  db: AppDB;
  fetch?: FetchLike;
  now?: () => number;
  newId?: () => string;
  errorLog?: ErrorLog;
  env?: SchedulerEnv;
};

type RunResult = { ok: true; value: SyncRunSummary } | { ok: false; error: SyncError };

export class SyncEngine {
  readonly #db: AppDB;
  readonly #fetch: FetchLike | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #errorLog: ErrorLog | undefined;
  readonly #env: SchedulerEnv;
  readonly #state: Signal<SyncState>;

  #config: { remoteUrl: string; user: string; password: string; remember: boolean } | null = null;
  #conflicts: ConflictSummary[] = [];
  #lastRun: SyncRunSummary | null = null;
  #lastSyncAt: number | null = null;
  #inFlight: Promise<RunResult> | null = null;
  #failures = 0;
  #retryAt: number | null = null;
  /** Decision 9.1: AUTH/CONFIG/SYNC_FORMAT_NEWER disable auto-retry until the user acts. */
  #autoSuspended = false;
  #timer: unknown = null;
  #listenersAttached = false;

  constructor(deps: SyncEngineDeps) {
    this.#db = deps.db;
    this.#fetch = deps.fetch;
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? ((): string => newUlid(this.#now()));
    this.#errorLog = deps.errorLog;
    this.#env = deps.env ?? defaultSchedulerEnv();
    this.#state = signal<SyncState>({
      status: 'idle',
      configured: false,
      autoSync: true,
      lastSyncAt: null,
      lastRun: null,
    });
    void this.#hydrate();
  }

  async #hydrate(): Promise<void> {
    const row = await ensureSyncState(this.#db, this.#db.deviceId);
    if (!row.ok) return;
    const record = row.value;
    const configured = record.enabled && record.remoteUrl.length > 0;
    if (record.remoteUrl.length > 0 && record.remotePassword.length > 0) {
      this.#config = {
        remoteUrl: record.remoteUrl,
        user: record.remoteUser,
        password: record.remotePassword,
        remember: true,
      };
    } else if (record.remoteUrl.length > 0) {
      this.#config = {
        remoteUrl: record.remoteUrl,
        user: record.remoteUser,
        password: '',
        remember: false,
      };
    }
    this.#lastSyncAt = record.lastSyncAt;
    this.#idle({ configured, autoSync: record.autoSync });
    if (configured && record.autoSync) this.#startScheduler();
  }

  #idle(patch: { configured?: boolean; autoSync?: boolean } = {}): void {
    const current = this.#state.value;
    const configured = patch.configured ?? (current.status === 'idle' ? current.configured : true);
    const autoSync = patch.autoSync ?? (current.status === 'idle' ? current.autoSync : true);
    this.#state.value = {
      status: 'idle',
      configured,
      autoSync,
      lastSyncAt: this.#lastSyncAt,
      lastRun: this.#lastRun,
    };
  }

  state(): Signal<SyncState> {
    return this.#state;
  }

  listConflicts(): ConflictSummary[] {
    return [...this.#conflicts];
  }

  acknowledgeConflicts(): void {
    this.#conflicts = [];
    this.#idle();
  }

  /** Decision 9.2: setup form submit. Additive `remember: false` = memory-only password (Decision 7). */
  async configure(cfg: {
    remoteUrl: string;
    user: string;
    password: string;
    remember?: boolean;
  }): Promise<Result<void, SyncError>> {
    const insecure = assertSecureRemote(cfg.remoteUrl);
    if (insecure !== null) {
      this.#errorState(insecure);
      return { ok: false, error: insecure };
    }
    const row = await ensureSyncState(this.#db, this.#db.deviceId);
    if (!row.ok) {
      const e: SyncError = {
        code: 'LOCAL_STORAGE',
        message: 'cannot persist sync configuration',
        retryable: true,
      };
      this.#errorState(e);
      return { ok: false, error: e };
    }
    const remember = cfg.remember ?? true;
    // A different remote starts fresh cursors (its batches are unknown to us);
    // the shadow stays — it is local truth for conflict detection.
    const remoteChanged = row.value.remoteUrl !== cfg.remoteUrl;
    const cursor = remoteChanged
      ? { pull: {}, snapshotKey: null, pushedUpTo: 0, pushedSeq: 0, remoteCoveredUpTo: null }
      : row.value.cursor;
    const next: SyncStateRecord = {
      ...row.value,
      enabled: true,
      remoteUrl: cfg.remoteUrl,
      remoteUser: cfg.user,
      remotePassword: remember ? cfg.password : '',
      cursor,
    };
    const saved = await this.#db.put('sync_state', next);
    if (!saved.ok) {
      const e: SyncError = {
        code: 'LOCAL_STORAGE',
        message: 'cannot persist sync configuration',
        retryable: true,
      };
      this.#errorState(e);
      return { ok: false, error: e };
    }
    this.#config = { remoteUrl: cfg.remoteUrl, user: cfg.user, password: cfg.password, remember };
    this.#failures = 0;
    this.#retryAt = null;
    this.#autoSuspended = false; // the user acted (fresh credentials) — auto-retry re-arms
    this.#idle({ configured: true, autoSync: next.autoSync });
    if (next.autoSync) this.#startScheduler();
    return { ok: true, value: undefined };
  }

  /** Decision 7: clear credentials + disable sync; task data is untouched. */
  async forgetCredentials(): Promise<Result<void, SyncError>> {
    const row = await ensureSyncState(this.#db, this.#db.deviceId);
    if (!row.ok) {
      return {
        ok: false,
        error: { code: 'LOCAL_STORAGE', message: 'cannot persist', retryable: true },
      };
    }
    const next: SyncStateRecord = {
      ...row.value,
      enabled: false,
      remoteUser: '',
      remotePassword: '',
    };
    const saved = await this.#db.put('sync_state', next);
    if (!saved.ok) {
      return {
        ok: false,
        error: { code: 'LOCAL_STORAGE', message: 'cannot persist', retryable: true },
      };
    }
    this.#config = null;
    this.#stopScheduler();
    this.#idle({ configured: false });
    return { ok: true, value: undefined };
  }

  /** Additive (Decision 9.2 seam for the setup wizard): probe only — zero local writes. */
  async probe(): Promise<Result<void, SyncError>> {
    const client = this.#client();
    if (client === null) {
      const e: SyncError = { code: 'CONFIG', message: 'sync is not configured', retryable: false };
      return { ok: false, error: e };
    }
    const result = await client.probe();
    return result.ok ? { ok: true, value: undefined } : { ok: false, error: result.error };
  }

  setAutoSync(on: boolean): void {
    void (async () => {
      const row = await ensureSyncState(this.#db, this.#db.deviceId);
      if (!row.ok) return;
      await this.#db.put('sync_state', { ...row.value, autoSync: on });
      if (on) this.#startScheduler();
      else this.#stopScheduler();
      const current = this.#state.value;
      if (current.status === 'idle') this.#idle({ autoSync: on });
    })();
  }

  /** Decision 5 preflight + single-flight (overlapping triggers coalesce). */
  runSync(trigger: 'manual' | 'auto'): Promise<RunResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    const run = this.#run(trigger).finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  async #run(trigger: 'manual' | 'auto'): Promise<RunResult> {
    const row = await ensureSyncState(this.#db, this.#db.deviceId);
    if (!row.ok) {
      const e: SyncError = {
        code: 'LOCAL_STORAGE',
        message: 'cannot read sync state',
        retryable: true,
      };
      this.#errorState(e);
      return { ok: false, error: e };
    }
    const record = row.value;
    const configured = record.enabled && record.remoteUrl.length > 0;
    const autoSync = record.autoSync;

    // Preflight (Decision 5 phase 1): skip (auto) or error (manual).
    const online = this.#env.isOnline();
    if (!configured) {
      const e: SyncError = { code: 'CONFIG', message: 'sync is not configured', retryable: false };
      if (trigger === 'manual') {
        this.#errorState(e);
        return { ok: false, error: e };
      }
      return { ok: true, value: this.#emptySummary(trigger) };
    }
    if (!online) {
      const e: SyncError = { code: 'NETWORK', message: 'offline', retryable: true };
      if (trigger === 'manual') {
        this.#errorState(e);
        return { ok: false, error: e };
      }
      return { ok: true, value: this.#emptySummary(trigger) };
    }
    if (trigger === 'auto' && !autoSync) return { ok: true, value: this.#emptySummary(trigger) };
    if (trigger === 'auto' && this.#autoSuspended)
      return { ok: true, value: this.#emptySummary(trigger) };
    if (trigger === 'auto' && this.#env.saveData())
      return { ok: true, value: this.#emptySummary(trigger) };
    if (trigger === 'auto' && this.#retryAt !== null && this.#now() < this.#retryAt) {
      return { ok: true, value: this.#emptySummary(trigger) };
    }

    const client = this.#client();
    if (client === null) {
      const e: SyncError = {
        code: 'CONFIG',
        message: 'credentials are not available',
        retryable: false,
      };
      this.#errorState(e);
      return { ok: false, error: e };
    }

    const startedAt = this.#now();
    this.#state.value = { status: 'syncing', phase: 'probe', startedAt };
    const onPhase = (phase: SyncRunPhase): void => {
      if (this.#state.value.status === 'syncing') {
        this.#state.value = { status: 'syncing', phase, startedAt };
      }
    };

    const outcome = await runSyncOnce(
      {
        db: this.#db,
        client,
        now: this.#now,
        newId: this.#newId,
        ...(this.#errorLog === undefined ? {} : { errorLog: this.#errorLog }),
      },
      { trigger, state: record, onPhase },
    );

    if (!outcome.ok) {
      const error = outcome.error;
      // LOCKED defers quietly (Decision 6) — not an error banner.
      if (error.code !== 'LOCKED') this.#errorState(error);
      else this.#idle();
      this.#recordFailure(error);
      return { ok: false, error };
    }
    return this.#accept(outcome.value);
  }

  #accept(outcome: RunOutcome): RunResult {
    this.#lastRun = outcome.summary;
    this.#lastSyncAt = outcome.summary.finishedAt;
    this.#failures = 0;
    this.#retryAt = null;
    if (outcome.conflicts.length > 0) {
      this.#conflicts = [...this.#conflicts, ...outcome.conflicts];
      this.#state.value = {
        status: 'conflicts-pending',
        conflicts: [...this.#conflicts],
        lastSyncAt: this.#lastSyncAt,
        lastRun: outcome.summary,
      };
    } else {
      this.#idle();
    }
    return { ok: true, value: outcome.summary };
  }

  #errorState(error: SyncError): void {
    this.#state.value = {
      status: 'error',
      error,
      lastSyncAt: this.#lastSyncAt,
      retryAt: this.#retryAt,
    };
    this.#errorLog?.record({ layer: 'domain', op: 'sync', error });
  }

  /** Backoff bookkeeping — auto-retry never touches AUTH/CONFIG/SYNC_FORMAT_NEWER. */
  #recordFailure(error: SyncError): void {
    if (
      !error.retryable ||
      error.code === 'AUTH' ||
      error.code === 'CONFIG' ||
      error.code === 'SYNC_FORMAT_NEWER'
    ) {
      this.#retryAt = null;
      // "Disable auto-retry until the user acts" (Decision 9.1) — ONLY for
      // AUTH/CONFIG/SYNC_FORMAT_NEWER; other non-retryable outcomes (e.g. a
      // corrupt artifact whose owner will re-upload) stay auto-eligible.
      if (error.code === 'AUTH' || error.code === 'CONFIG' || error.code === 'SYNC_FORMAT_NEWER') {
        this.#autoSuspended = true;
      }
      return;
    }
    const step =
      BACKOFF_STEPS_MS[Math.min(this.#failures, BACKOFF_STEPS_MS.length - 1)] ?? 30 * 60_000;
    this.#failures += 1;
    this.#retryAt = this.#now() + step;
  }

  #emptySummary(trigger: 'manual' | 'auto'): SyncRunSummary {
    const at = this.#now();
    return {
      startedAt: at,
      finishedAt: at,
      trigger,
      pulled: { snapshots: 0, batches: 0, records: 0 },
      pushed: { batches: 0, records: 0 },
      applied: 0,
      conflictsCreated: 0,
      compacted: false,
      notices: [],
    };
  }

  #client(): WebDavClient | null {
    const cfg = this.#config;
    if (cfg === null || cfg.password.length === 0) return null;
    return new WebDavClient(
      { baseUrl: cfg.remoteUrl, user: cfg.user, password: cfg.password },
      this.#fetch === undefined ? {} : { fetch: this.#fetch },
    );
  }

  /* ------------------------- scheduling (Decision 9.1) ------------------------- */

  #startScheduler(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#env.setInterval(() => {
      void this.runSync('auto');
    }, AUTO_SYNC_INTERVAL_MS);
    if (!this.#listenersAttached) {
      this.#env.addEventListener('online', this.#onWake);
      this.#env.addEventListener('visibilitychange', this.#onWake);
      this.#listenersAttached = true;
    }
  }

  #stopScheduler(): void {
    if (this.#timer !== null) {
      this.#env.clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#listenersAttached) {
      this.#env.removeEventListener('online', this.#onWake);
      this.#env.removeEventListener('visibilitychange', this.#onWake);
      this.#listenersAttached = false;
    }
  }

  readonly #onWake = (): void => {
    // online event fires immediately; a visible tab syncs when stale.
    const stale =
      this.#lastSyncAt === null || this.#now() - this.#lastSyncAt >= AUTO_SYNC_INTERVAL_MS;
    if (this.#env.isOnline() && (this.#env.isVisible() || stale)) {
      void this.runSync('auto');
    }
  };

  /** Test/teardown seam. */
  dispose(): void {
    this.#stopScheduler();
  }
}
