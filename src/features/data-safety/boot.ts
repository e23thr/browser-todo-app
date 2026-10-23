/**
 * Data-safety boot (E3): classify the profile once per session, wire the ADR-004 engine, and
 * arm the notice queues.
 *
 * Ordering matters (§3.4): the `meta` probe MUST read `lastOpenedAt`/`createdAt` before
 * `boot()` bumps `lastOpenedAt` in its step 5, so `beginPriorUseProbe()` is kicked off first
 * from `main.tsx` — before the first render, and therefore before anything else can call
 * `boot()`. The probe is bounded (a broken/hung IndexedDB must never block paint) and
 * degrades to "unknown" rather than guessing.
 *
 * Everything here is best-effort by design (§9.4): a failed probe, a missing StorageManager or
 * a rejected boot degrade the surface — they never stop the app from starting.
 */

import {
  bindDataSafetyDb,
  listSnapshots,
  maybeScheduledSnapshot,
  parseBackupDocument,
} from '../../portability';
import { bootCodec } from '../../app/bootCodec';
import { boot } from '../../storage/boot';
import type { AppDBImpl } from '../../storage/db';
import { LONG_ABSENCE_DAYS, MAX_SHRINK_PROBE_BYTES, SHRINK_RATIO } from './constants';
import { deriveBanners } from './derive';
import { invalidateCounts, probeData, readCounts, readLastBackupAt } from './dbAccess';
import { readOnboardingStep, recoveryStartedAt } from './flags';
import { beginPriorUseProbe, resetPriorUseProbe } from './probe';
import { patchState } from './state';
import { refreshPersistence, refreshQuota } from './storageInfo';
import type { BootClassification, DataCounts } from './types';

/* ------------------------------ row inventory ------------------------------ */
/* Counts/probe/settings reads live in `dbAccess.ts` so the actions and the import flow can
 * share them without importing the boot orchestrator. */

/* ------------------------------ classification ----------------------------- */

export interface ClassifyInput {
  readonly priorUse: boolean;
  readonly hasData: boolean;
  readonly lastBackupAt: number | null;
  /** Whole days between `meta.lastOpenedAt` (pre-boot) and now; `null` = unknown. */
  readonly absentDays: number | null;
  /** Live-record inventory now vs in the newest snapshot; `null` = no baseline to compare. */
  readonly shrink: { readonly current: DataCounts; readonly baseline: DataCounts } | null;
  readonly storeCreatedAt: number | null;
  readonly recoveryAckAt: number | null;
}

/**
 * §3.4 table, in priority order: wiped → long absence → shrunken → normal. Pure — the unit
 * tests drive this directly with mocked inputs.
 */
export function classifyBoot(input: ClassifyInput): BootClassification {
  if (!input.hasData) {
    // Fresh profile (no evidence of prior use) is NOT a wipe: that row is onboarding's job.
    if (!input.priorUse) return { kind: 'normal' };
    // The user already acknowledged a wipe for THIS store instance: same episode, don't nag.
    const acknowledged =
      input.storeCreatedAt !== null &&
      input.recoveryAckAt !== null &&
      input.storeCreatedAt < input.recoveryAckAt;
    if (acknowledged) return { kind: 'normal' };
    return { kind: 'wiped', lastBackupAt: input.lastBackupAt };
  }

  if (input.absentDays !== null && input.absentDays >= LONG_ABSENCE_DAYS) {
    return {
      kind: 'long-absence',
      absentDays: input.absentDays,
      lastBackupAt: input.lastBackupAt,
    };
  }

  const shrink = input.shrink;
  if (shrink !== null) {
    const before = shrink.baseline.lists + shrink.baseline.tasks;
    const now = shrink.current.lists + shrink.current.tasks;
    if (before > 0 && now < before * (1 - SHRINK_RATIO)) {
      return { kind: 'shrunken', dropped: 1 - now / before, baseline: shrink.baseline };
    }
  }

  return { kind: 'normal' };
}

/** Live-record inventory inside the newest snapshot payload, or `null` when unusable. */
async function readBaseline(db: AppDBImpl): Promise<DataCounts | null> {
  const listed = await listSnapshots({ db });
  if (!listed.ok) return null;
  const newest = listed.value[0];
  if (newest === undefined || newest.sizeBytes > MAX_SHRINK_PROBE_BYTES) return null;

  const stored = await db.get('snapshot_payloads', newest.id);
  if (!stored.ok || stored.value === undefined) return null;
  const payload = stored.value;

  const parsed = parseBackupDocument(payload.payload, {
    targetSchemaVersion: Number.MAX_SAFE_INTEGER,
  });
  if (!parsed.ok) return null;

  const live = (rows: readonly unknown[]): unknown[] =>
    rows.filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' &&
        row !== null &&
        (row as { deletedAt?: unknown }).deletedAt === null,
    );
  const lists = live(parsed.value.lists);
  const tasks = live(parsed.value.tasks);
  return {
    lists: lists.length,
    tasks: tasks.length,
    doneTasks: tasks.filter((task) => (task as { status?: unknown }).status === 'done').length,
    hasData: lists.length + tasks.length > 0,
  };
}

/* -------------------------------- orchestration ---------------------------- */

let started: Promise<void> | null = null;

/**
 * Boot the surface: probe (already in flight) → ADR-004 boot → classify → arm banners →
 * scheduled snapshot → quota/persistence refresh. Idempotent; safe to `void`.
 */
export function startDataSafety(opts: { now?: () => number } = {}): Promise<void> {
  started ??= run(opts);
  return started;
}

/** Test seam. */
export function resetDataSafetyBoot(): void {
  started = null;
  resetPriorUseProbe();
  invalidateCounts();
}

async function run(opts: { now?: () => number }): Promise<void> {
  const now = opts.now ?? Date.now;
  const probe = await beginPriorUseProbe();

  const booted = await boot({ codec: await bootCodec(), now });
  if (!booted.ok) {
    // §9.4 degrade: no storage → no panel data, but the shell still renders.
    patchState({ status: 'failed', onboarding: !hasFlaggedPriorUse() });
    return;
  }

  const db = booted.value as AppDBImpl;
  bindDataSafetyDb(db);

  const lastBackupAt = await readLastBackupAt(db);
  const probed = await probeData(db);
  const snapshots = await listSnapshots({ db });
  const snapshotRows = snapshots.ok ? snapshots.value : [];
  const snapshotMeta = snapshotRows.slice(0, 3);

  const hasData = probed?.hasData ?? true;
  const absentDays =
    probe === null ? null : Math.max(0, Math.floor((now() - probe.lastOpenedAt) / 86_400_000));

  let shrink: ClassifyInput['shrink'] = null;
  if (hasData && snapshotRows.length > 0) {
    const baseline = await readBaseline(db);
    if (baseline !== null) {
      shrink = { current: probed ?? (await readCounts(db)), baseline };
    }
  }

  const priorUse = hasFlaggedPriorUse() || probe !== null || lastBackupAt !== null || hasData;

  const classification = classifyBoot({
    priorUse,
    hasData,
    lastBackupAt,
    absentDays,
    shrink,
    storeCreatedAt: probe?.createdAt ?? null,
    recoveryAckAt: recoveryStartedAt(),
  });

  patchState({
    status: 'ready',
    classification,
    counts: probed,
    hasData,
    lastBackupAt,
    snapshots: snapshotMeta,
    priorUse,
    onboarding: !priorUse && classification.kind !== 'wiped',
  });

  deriveBanners(now());

  // M12 §8.3: at most one scheduled snapshot per 24 h. Failure is recorded locally and boot
  // continues (the API handoff: "record a warning; boot continues").
  void maybeScheduledSnapshot({ db, now }).then((result) => {
    if (!result.ok) console.warn('data-safety: scheduled snapshot failed', result.error.code);
  });

  await Promise.all([refreshQuota(), refreshPersistence()]);
  deriveBanners(now());
}

function hasFlaggedPriorUse(): boolean {
  return readOnboardingStep() === 'done';
}
