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
import { hasPriorData, markPriorData, readOnboardingStep, recoveryStartedAt } from './flags';
import { beginPriorUseProbe, resetPriorUseProbe } from './probe';
import { initCryptoForApp } from '../crypto/wiring';
import { patchState } from './state';
import { refreshPersistence, refreshQuota } from './storageInfo';
import type { BootClassification, DataCounts } from './types';

/* ------------------------------ row inventory ------------------------------ */
/* Counts/probe/settings reads live in `dbAccess.ts` so the actions and the import flow can
 * share them without importing the boot orchestrator. */

/* ------------------------------ classification ----------------------------- */

export interface ClassifyInput {
  readonly priorUse: boolean;
  /**
   * Evidence this profile once HELD tasks/lists — the real discriminator behind §3.4's row 1
   * ("store empty AND remembers prior use"). Derived by `hasPriorDataEvidence()`; `false` on a
   * profile that booted and wrote settings but never held a row, which is row 4 (normal), not a
   * wipe. "Empty" is not the same claim as "erased".
   */
  readonly priorData: boolean;
  readonly hasData: boolean;
  readonly lastBackupAt: number | null;
  /** Whole days between `meta.lastOpenedAt` (pre-boot) and now; `null` = unknown. */
  readonly absentDays: number | null;
  /** Live-record inventory now vs in the newest snapshot; `null` = no baseline to compare. */
  readonly shrink: { readonly current: DataCounts; readonly baseline: DataCounts } | null;
  readonly storeCreatedAt: number | null;
  readonly recoveryAckAt: number | null;
}

/** Everything `run()` knows when it asks "did this profile once hold rows?" (pure — unit tested). */
export interface PriorDataEvidence {
  /** Live rows right now (the store is its own proof). */
  readonly hasData: boolean;
  /** `settings.lastBackupAt` — a backup was taken from this profile. */
  readonly lastBackupAt: number | null;
  /** The durable `had-data` flags mark (ADR-002 Decision 7), written when rows first exist. */
  readonly markedPriorData: boolean;
  /** Live rows inside the newest snapshot payload; `null` when there is no snapshot to read. */
  readonly snapshotCounts: DataCounts | null;
}

/**
 * §3.4 row-1 discriminator: is there evidence that this profile once HELD tasks/lists?
 *
 * Every source is testimony about the PAST, because the wipe case is precisely the one where the
 * store itself has nothing to say. The durable mark matters most: it is the only source that
 * survives the eviction the recovery screen exists for (IndexedDB and its snapshots are what
 * disappear; localStorage is assumed to remain, exactly as §3.4's row 1 assumes).
 */
export function hasPriorDataEvidence(evidence: PriorDataEvidence): boolean {
  if (evidence.hasData) return true;
  if (evidence.markedPriorData) return true;
  if (evidence.lastBackupAt !== null) return true;
  const snapshot = evidence.snapshotCounts;
  return snapshot !== null && snapshot.lists + snapshot.tasks > 0;
}

/**
 * §3.4 table, in priority order: wiped → long absence → shrunken → normal. Pure — the unit
 * tests drive this directly with mocked inputs.
 */
export function classifyBoot(input: ClassifyInput): BootClassification {
  if (!input.hasData) {
    // "Store empty" is only a WIPE when there is evidence this profile once held rows: a fresh
    // profile has no memory at all (row 4 → onboarding), and a profile that booted, wrote
    // settings and never had a task has use without data (row 4 → normal). Reading an empty
    // store as an erased one is what put the recovery screen in front of ordinary boots.
    if (!input.priorUse || !input.priorData) return { kind: 'normal' };
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
  // ADR-007: the C1 session vault attaches to the booted DB and the row/merge
  // seams register before any task/list read/write crosses the boundary.
  await initCryptoForApp(db);

  const lastBackupAt = await readLastBackupAt(db);
  const probed = await probeData(db);
  const snapshots = await listSnapshots({ db });
  const snapshotRows = snapshots.ok ? snapshots.value : [];
  const snapshotMeta = snapshotRows.slice(0, 3);

  const hasData = probed?.hasData ?? true;
  const absentDays =
    probe === null ? null : Math.max(0, Math.floor((now() - probe.lastOpenedAt) / 86_400_000));

  // Newest snapshot payload, read once and bounded (§9.1): it is the shrink baseline while the
  // store still holds rows, and past-data testimony for the empty-store case below.
  const baseline = snapshotRows.length > 0 ? await readBaseline(db) : null;

  let shrink: ClassifyInput['shrink'] = null;
  if (hasData && baseline !== null) {
    shrink = { current: probed ?? (await readCounts(db)), baseline };
  }

  const priorUse = hasFlaggedPriorUse() || probe !== null || lastBackupAt !== null || hasData;

  const priorData = hasPriorDataEvidence({
    hasData,
    lastBackupAt,
    markedPriorData: hasPriorData(),
    snapshotCounts: baseline,
  });
  // Make the evidence durable the moment it holds: the wipe this classifier exists to catch is
  // the one where IndexedDB — rows, snapshots, settings, meta — is already gone at the next
  // boot, so the flags mark is the witness that outlives it (§3.4 row 1's "localStorage
  // remembers"). A profile that has never held a row never writes it, so an ordinary boot with
  // zero tasks classifies as normal instead of "wiped".
  if (priorData) markPriorData();

  const classification = classifyBoot({
    priorUse,
    priorData,
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
