/**
 * `sync_state` store (ADR-006 Decision 3) at the storage level: the v1→v3
 * migration chain seeds the singleton row, boot validation accepts/repairs it,
 * and the row NEVER leaks into exports or snapshots (local-only).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openRawAppDB } from '../../../src/storage/db';
import { resetBootSingleton, boot } from '../../../src/storage/boot';
import { newUlid } from '../../../src/storage/id';
import { productionMigrations, targetVersionOf } from '../../../src/storage/migrations';
import { META_KEY, SYNC_KEY, APP_SCHEMA_VERSION } from '../../../src/storage/schema';
import {
  defaultSyncStateRow,
  ensureSyncState,
  readSyncState,
} from '../../../src/storage/syncState';
import { readSnapshotSource } from '../../../src/storage/snapshots';
import { validateRow, validateSyncState } from '../../../src/storage/validate';
import type { Meta, SyncStateRecord } from '../../../src/storage/types';

afterEach(() => {
  resetBootSingleton();
});

let seq = 0;
function dbName(): string {
  seq += 1;
  return `sync-state-test-${String(Date.now())}-${String(seq)}`;
}

describe('sync_state migration (ADR-002 chain, step 2)', () => {
  it('registry: exactly one contiguous step per version (two steps at one version brick boot)', () => {
    const versions = productionMigrations.map((s) => s.to).sort((a, b) => a - b);
    expect(new Set(versions).size).toBe(versions.length); // no duplicates
    // v1 is the ADR-002 BASELINE (no step); every version above it needs exactly one.
    for (let v = 2; v <= targetVersionOf(productionMigrations); v += 1) {
      expect(versions).toContain(v); // contiguous 2..target
    }
    expect(versions).toContain(2); // sync_state owns step 2 (ADR-007 pins it)
  });

  it('a v1 database migrates through the chain and gains the seeded singleton row', async () => {
    const name = dbName();
    // Seed a schemaVersion-1 database the way the MVP shipped it.
    const raw = await openRawAppDB({ dbName: name });
    expect(raw.ok).toBe(true);
    if (!raw.ok) return;
    const meta: Meta = {
      schemaVersion: 1,
      deviceId: newUlid(1000),
      createdAt: 1000,
      lastOpenedAt: 1000,
    };
    await raw.value.put('meta', meta, META_KEY);
    raw.value.close();

    const booted = await boot({ dbName: name, now: () => 2000 });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    expect(booted.value.schemaVersion).toBe(targetVersionOf(productionMigrations));
    const row = await readSyncState(booted.value);
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    expect(row.value?.id).toBe(SYNC_KEY);
    expect(row.value?.deviceId).toBe(meta.deviceId); // mirrors meta (Decision 3)
    expect(row.value?.enabled).toBe(false); // opt-in: never enabled by migration
  });

  it('the step is idempotent — an existing row is never touched', async () => {
    const name = dbName();
    const raw = await openRawAppDB({ dbName: name });
    if (!raw.ok) return;
    const meta: Meta = {
      schemaVersion: 1,
      deviceId: newUlid(1000),
      createdAt: 1000,
      lastOpenedAt: 1000,
    };
    await raw.value.put('meta', meta, META_KEY);
    await raw.value.put('sync_state', {
      ...defaultSyncStateRow(meta.deviceId),
      enabled: true,
      remoteUrl: 'https://kept.example/dav/',
    } satisfies SyncStateRecord);
    raw.value.close();

    const booted = await boot({ dbName: name, now: () => 2000 });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    const row = await readSyncState(booted.value);
    expect(row.ok && row.value?.enabled).toBe(true);
    expect(row.ok && row.value?.remoteUrl).toBe('https://kept.example/dav/');
  });

  it('fresh installs seed lazily via ensureSyncState (the engine fallback)', async () => {
    const name = dbName();
    const booted = await boot({ dbName: name });
    expect(booted.ok).toBe(true);
    if (!booted.ok) return;
    const before = await readSyncState(booted.value);
    expect(before.ok && before.value).toBeUndefined(); // no step ran on a fresh v3 boot
    const seeded = await ensureSyncState(booted.value, booted.value.deviceId);
    expect(seeded.ok && seeded.value.deviceId).toBe(booted.value.deviceId);
    expect(seeded.ok && seeded.value.enabled).toBe(false);
  });
});

describe('sync_state validation (boot quarantine surface)', () => {
  it('accepts the default row and rejects corruption strictly', () => {
    expect(validateSyncState(defaultSyncStateRow(newUlid(1000))).ok).toBe(true);
    expect(validateSyncState({ ...defaultSyncStateRow(newUlid(1000)), id: 'nope' }).ok).toBe(false);
    expect(
      validateSyncState({ ...defaultSyncStateRow(newUlid(1000)), lastError: 'NOT_A_CODE' }).ok,
    ).toBe(false);
    expect(
      validateSyncState({
        ...defaultSyncStateRow(newUlid(1000)),
        shadow: { ['x'.repeat(26)]: { updatedAt: 1, deviceId: 'y', contentHash: 'zz' } },
      }).ok,
    ).toBe(false);
    expect(validateRow('sync_state', defaultSyncStateRow(newUlid(1000))).ok).toBe(true);
  });
});

describe('sync_state is local-only (ADR-006 Decision 3 exclusion)', () => {
  it('readSnapshotSource never captures sync_state rows (exports/snapshots/remote stay clean)', async () => {
    const name = dbName();
    const booted = await boot({ dbName: name });
    if (!booted.ok) return;
    const seeded = await ensureSyncState(booted.value, booted.value.deviceId);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    await booted.value.put('sync_state', {
      ...seeded.value,
      remotePassword: 'must-never-leak',
      remoteUrl: 'https://secret.example/dav/',
    });

    // readSnapshotSource wants the internal handle; the AppDB surface is enough here.
    const source = await readSnapshotSource(
      booted.value as unknown as Parameters<typeof readSnapshotSource>[0],
    );
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.value.stores.sync_state).toEqual([]);
    const serialized = JSON.stringify(source.value.stores);
    expect(serialized).not.toContain('must-never-leak');
    expect(serialized).not.toContain('secret.example');
    expect(APP_SCHEMA_VERSION).toBe(3); // chain map stays contiguous with E7's step
  });
});
