/**
 * Sync-engine host for the sync UI (E8 S9) — the single place `SyncEngine` is
 * constructed and bound for the app (contract: docs/dev/sync-engine-api.md).
 *
 * Boot discipline: the shared database must be opened by the data-safety boot
 * FIRST (ADR-004's snapshot codec rides on that initial `boot()` call), so
 * `bootSyncEngine()` only ever adopts the ALREADY-bound database handle — it
 * never wins the boot race itself. Until then it returns `null` and the panel
 * degrades to honest copy; the UI never opens storage on its own.
 *
 * Test seam: `bindSyncEngineForTest(engine, db)` installs any engine (a real
 * one over the fixtures, or a structural fake for pure render paths).
 */

import { signal } from '@preact/signals';

import { resolveDataSafetyDb } from '../../portability';
import type { AppDB } from '../../storage/db';
import { defaultErrorLog } from '../../storage/errorLog';
import { readSyncState } from '../../storage/syncState';
import { SyncEngine } from '../../sync';
import type { SyncEngineApi } from '../../sync';

/** The engine surface the UI needs — `SyncEngine` plus its teardown hook. */
export type SyncHostEngine = SyncEngineApi & { dispose(): void };

/** The address + user on file (for prefilling the wizard). Passwords are never read here. */
export interface SyncConfigPrefill {
  readonly remoteUrl: string;
  readonly remoteUser: string;
}

let engine: SyncHostEngine | null = null;
let boundDb: AppDB | null = null;

/**
 * Bumped whenever an engine is (re)bound — the UI subscription seam: a panel
 * that rendered before the engine existed re-renders when it appears.
 */
export const syncEngineEpoch = signal(0);

/** The bound engine, or `null` while storage is not ready yet. */
export function syncEngine(): SyncHostEngine | null {
  return engine;
}

/**
 * Adopt the bound database and construct the production engine (idempotent).
 * Returns `null` — never throws — while storage is unbound or unusable.
 */
export function bootSyncEngine(): SyncHostEngine | null {
  if (engine !== null) return engine;
  try {
    const resolved = resolveDataSafetyDb();
    if (!resolved.ok) return null;
    boundDb = resolved.value;
    engine = new SyncEngine({ db: resolved.value, errorLog: defaultErrorLog });
    syncEngineEpoch.value += 1;
    return engine;
  } catch {
    // §9.4 degrade: no engine, honest "unavailable" copy — never a crash.
    return null;
  }
}

/**
 * Read the stored address + user for wizard prefill ("Enter credentials
 * again"). Never returns the password; `null` when no database is known.
 */
export async function readSyncConfig(): Promise<SyncConfigPrefill | null> {
  const db = boundDb;
  if (db === null) return null;
  try {
    const row = await readSyncState(db);
    if (!row.ok || row.value === undefined) return null;
    if (row.value.remoteUrl.length === 0) return null;
    return { remoteUrl: row.value.remoteUrl, remoteUser: row.value.remoteUser };
  } catch {
    return null;
  }
}

/** Test seam: install (or clear, with `null`) the engine the panel renders. */
export function bindSyncEngineForTest(next: SyncHostEngine | null, db: AppDB | null = null): void {
  if (engine !== null && engine !== next) engine.dispose();
  engine = next;
  boundDb = db;
  syncEngineEpoch.value += 1;
}

/** Drop the engine (teardown between tests; disposes schedulers/listeners). */
export function resetSyncHost(): void {
  engine?.dispose();
  engine = null;
  boundDb = null;
  syncEngineEpoch.value += 1;
}
