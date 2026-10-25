/**
 * Document upgrade (ADR-004 Decision 4): old exports go through the SAME
 * forward-only migration registry as database migrations, over an in-memory `Tx`
 * adapter — one migration implementation, two substrates, so export-upgrades can
 * never drift from DB-upgrades. Failure = `UPGRADE_FAILED`, zero side effects
 * (the adapter is memory-only).
 *
 * Records that no `Tx` substrate can carry faithfully (missing/duplicate `id`)
 * bypass the in-memory chain untouched: they are ALWAYS quarantined by Stage B,
 * and passing them through keeps their exact source bytes in the recovery file
 * (no-silent-loss).
 */

import { err, ok } from '../storage/errors';
import type { Result } from '../storage/errors';
import { migrateRows, targetVersionOf } from '../storage/migrations';
import type { MigrationRegistry } from '../storage/migrations';
import type { List, Settings, Snapshot, StoreRows, Task } from '../storage/types';
import type { RawBackup } from './backup-document';
import type { Anchored } from './records';
import type { ImportError } from './types';

export type UpgradedSections = {
  schemaVersion: number;
  settings: Anchored;
  lists: Anchored[];
  tasks: Anchored[];
  snapshots: Anchored[];
};

function idOf(record: unknown): string | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const id = (record as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}

/** Split a raw section into migration-carryable rows and pass-through records. */
function partition(items: readonly unknown[]): { keyed: unknown[]; passthrough: Anchored[] } {
  const seen = new Set<string>();
  const keyed: unknown[] = [];
  const passthrough: Anchored[] = [];
  for (const record of items) {
    const id = idOf(record);
    if (id === null || seen.has(id)) {
      passthrough.push({ raw: record, record });
      continue;
    }
    seen.add(id);
    keyed.push(record);
  }
  return { keyed, passthrough };
}

function anchorAll(items: readonly unknown[]): Anchored[] {
  return items.map((record) => ({ raw: record, record }));
}

/**
 * Upgrade `raw` (schemaVersion S) to the registry target T. `S === T` is a
 * pure pass-through; `S > T` is rejected earlier (Stage A, `NEWER_SCHEMA`).
 */
export async function upgradeRawBackup(
  raw: RawBackup,
  registry: MigrationRegistry,
): Promise<Result<UpgradedSections, ImportError>> {
  const target = targetVersionOf(registry);

  const settingsPart = partition([raw.settings]);
  const listsPart = partition(raw.lists);
  const tasksPart = partition(raw.tasks);
  const snapshotsPart = partition(raw.snapshots);

  if (raw.schemaVersion === target) {
    return ok({
      schemaVersion: target,
      settings: { raw: raw.settings, record: raw.settings },
      lists: anchorAll(raw.lists),
      tasks: anchorAll(raw.tasks),
      snapshots: anchorAll(raw.snapshots),
    });
  }

  // The document substrate: `meta` is seeded from the envelope and absorbed
  // in-memory; `snapshot_payloads` is empty (payloads are out of document scope).
  const rows: StoreRows = {
    meta: [
      {
        schemaVersion: raw.schemaVersion,
        deviceId: raw.deviceId,
        createdAt: raw.exportedAt,
        lastOpenedAt: raw.exportedAt,
      },
    ],
    lists: listsPart.keyed as List[],
    tasks: tasksPart.keyed as Task[],
    settings: settingsPart.keyed as Settings[],
    snapshots: snapshotsPart.keyed as Snapshot[],
    snapshot_payloads: [],
    // ADR-006 Decision 3: sync_state is local-only — always empty in document
    // rows; the migration step may seed it in-memory and the projection below
    // deliberately ignores it.
    sync_state: [],
    // ADR-007 Decision 2.4: crypto_state is local-only — never in documents.
    crypto_state: [],
  };

  const migrated = await migrateRows(registry, rows, raw.schemaVersion, target);
  if (!migrated.ok) {
    return err({
      code: 'UPGRADE_FAILED',
      from: raw.schemaVersion,
      to: target,
      cause: migrated.error,
    });
  }

  const out = migrated.value.rows;
  const anchorMigrated = (
    store: 'lists' | 'tasks' | 'snapshots',
    passthrough: Anchored[],
  ): Anchored[] => {
    const source = new Map<string, unknown>();
    const sourceItems =
      store === 'lists'
        ? listsPart.keyed
        : store === 'tasks'
          ? tasksPart.keyed
          : snapshotsPart.keyed;
    for (const record of sourceItems) {
      const id = idOf(record);
      if (id !== null) source.set(id, record);
    }
    const anchored: Anchored[] = out[store].map((record) => {
      const id = idOf(record);
      const rawSource = id !== null ? source.get(id) : undefined;
      return { raw: rawSource ?? record, record };
    });
    return [...anchored, ...passthrough];
  };

  const settingsRow = out.settings[0];
  return ok({
    schemaVersion: target,
    settings: {
      raw: settingsPart.keyed.length > 0 ? (settingsPart.keyed[0] ?? raw.settings) : raw.settings,
      record: settingsRow ?? raw.settings,
    },
    lists: anchorMigrated('lists', listsPart.passthrough),
    tasks: anchorMigrated('tasks', tasksPart.passthrough),
    snapshots: anchorMigrated('snapshots', snapshotsPart.passthrough),
  });
}
