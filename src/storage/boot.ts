/**
 * Boot sequence (ADR-002 Decision 8, normative order):
 *   1. Open the DB (structural upgrades in `onupgradeneeded`, purely additive).
 *   2. Read `meta`; seed on first boot (schemaVersion + fresh deviceId ULID).
 *   3. schemaVersion < target → pre-migration snapshot → migration steps.
 *   4. Boot validation: quarantine invalid records (non-destructive denylist).
 *   5. `meta.lastOpenedAt` = now; throttled tombstone purge.
 *
 * `boot()` is idempotent per app instance (singleton per DB name). A newer
 * `meta.schemaVersion` never blocks reads — it sets the NEWER_SCHEMA write
 * guard so nothing is mutated (Decision 2).
 */

import { classifyUnknown, err, ok } from './errors';
import type { Result, StorageError } from './errors';
import { AppDBImpl, openRawAppDB } from './db';
import type { AppDB, BootReport } from './db';
import { newUlid } from './id';
import { productionMigrations, runMigrations, targetVersionOf } from './migrations';
import type { MigrationRegistry } from './migrations';
import { purgeTombstones } from './purge';
import { runBootValidation } from './quarantine';
import { APP_SCHEMA_VERSION, META_KEY } from './schema';
import { fallbackRawCodec } from './snapshots';
import type { SnapshotCodec } from './snapshots';
import type { Meta } from './types';

export type BootOptions = {
  dbName?: string;
  /** Migration registry (tests inject chains; production default is `productionMigrations`). */
  registry?: MigrationRegistry;
  /** Payload codec seam — E3 plugs ADR-004's serializer here. */
  codec?: SnapshotCodec;
  now?: () => number;
};

const bootCache = new Map<string, Promise<Result<AppDB, StorageError>>>();

/** Tear down the singleton (tests / before reload). */
export function resetBootSingleton(dbName?: string): void {
  if (dbName === undefined) {
    for (const cached of bootCache.values()) {
      void cached.then((r) => {
        if (r.ok) r.value.close();
      });
    }
    bootCache.clear();
    return;
  }
  const cached = bootCache.get(dbName);
  if (cached !== undefined) {
    void cached.then((r) => {
      if (r.ok) r.value.close();
    });
    bootCache.delete(dbName);
  }
}

export function boot(options: BootOptions = {}): Promise<Result<AppDB, StorageError>> {
  const name = options.dbName ?? 'local-first-todo';
  const cached = bootCache.get(name);
  if (cached !== undefined) return cached;
  const promise = bootFresh(options);
  bootCache.set(name, promise);
  return promise;
}

async function bootFresh(options: BootOptions): Promise<Result<AppDB, StorageError>> {
  const now = options.now ?? Date.now;
  const registry = options.registry ?? productionMigrations;
  const codec = options.codec ?? fallbackRawCodec;

  const opened = await openRawAppDB(options.dbName === undefined ? {} : { dbName: options.dbName });
  if (!opened.ok) return err(opened.error);
  const raw = opened.value;

  // Step 2: read + seed meta.
  let meta: Meta | undefined;
  try {
    meta = (await raw.get('meta', META_KEY)) as Meta | undefined;
  } catch (e) {
    raw.close();
    // classify, never wrap: a QuotaExceededError here must reach the §5.5
    // export/cleanup dialog as QUOTA_EXCEEDED, not drown as UNKNOWN (QA D3).
    return err(classifyUnknown(e));
  }

  const target = targetVersionOf(registry);

  if (meta === undefined) {
    meta = {
      schemaVersion: APP_SCHEMA_VERSION,
      deviceId: newUlid(now()),
      createdAt: now(),
      lastOpenedAt: now(),
    };
    try {
      // `meta` is out-of-line keyed: the key must be passed explicitly (ADR-002 §3.1).
      await raw.put('meta', meta, META_KEY);
    } catch (e) {
      raw.close();
      return err(classifyUnknown(e)); // same contract as the read above (QA D3)
    }
  }

  // QA defect D4: `meta.schemaVersion` is only a version when it is an integer
  // >= 1. A corrupt value (e.g. 0.5) must never feed the migration comparison —
  // it produced a bogus `migrated` report and a spurious pre-migration snapshot
  // on EVERY boot. Version unknown -> no chain, no snapshot, no NEWER_SCHEMA
  // comparison; the row is quarantined by step 4 and heals via snapshot restore.
  const versionKnown = trustworthySchemaVersion(meta.schemaVersion);
  const resolvedVersion = versionKnown ? meta.schemaVersion : target;

  const report: BootReport = {
    schemaVersion: resolvedVersion,
    migrated: null,
    preMigrationSnapshotId: null,
    quarantined: 0,
    purgedTombstones: 0,
    newerSchema: null,
    bootWarnings: [],
  };

  const db = new AppDBImpl(raw, { ...meta, schemaVersion: resolvedVersion }, report);

  // NEWER_SCHEMA: reads stay available, every write refuses (Decision 2).
  if (versionKnown && meta.schemaVersion > target) {
    db.setWriteGuard({ code: 'NEWER_SCHEMA', found: meta.schemaVersion, supported: target });
    db.updateReport({
      newerSchema: { found: meta.schemaVersion, supported: target },
    });
    const validated = await runBootValidation(db);
    if (validated.ok) {
      db.setQuarantine(validated.value);
      db.updateReport({ quarantined: validated.value.length });
    }
    return ok(db);
  }

  // Step 3: migration chain (snapshot-first, atomic steps, rollback on failure).
  // Skipped when the declared version is untrustworthy (D4): there is nothing
  // truthful to migrate from, and guessing a version would corrupt the data.
  if (versionKnown) {
    const migrated = await runMigrations(db, { registry, codec, now });
    if (!migrated.ok) {
      // Migration failed and rolled back: typed error out, connection closed.
      // The DB is back on the old version and still readable next boot.
      db.close();
      return err(migrated.error);
    }
    if (migrated.value.preMigrationSnapshotId !== null) {
      db.updateReport({
        migrated: { from: migrated.value.from, to: migrated.value.to },
        preMigrationSnapshotId: migrated.value.preMigrationSnapshotId,
      });
      db.setSchemaVersion(migrated.value.to);
    }
  }

  // Step 4: boot validation + quarantine (non-destructive).
  const validated = await runBootValidation(db);
  if (!validated.ok) {
    db.close();
    return err(validated.error);
  }
  db.setQuarantine(validated.value);
  db.updateReport({ quarantined: validated.value.length });

  // Step 5: lastOpenedAt bump + throttled tombstone purge. Failures here are
  // bookkeeping — non-fatal, but recorded as warnings (never silently dropped).
  const bumped = await db.tx(['meta'], 'readwrite', async (t) => {
    const current = await t.get('meta', META_KEY);
    if (current === undefined) return ok(undefined);
    await t.put('meta', { ...current, lastOpenedAt: now() });
    return ok(undefined);
  });
  if (!bumped.ok) {
    db.updateReport({
      bootWarnings: [...db.bootReport.bootWarnings, { step: 'lastOpenedAt', error: bumped.error }],
    });
  }

  const purged = await purgeTombstones(db, { now: now(), mode: 'auto' });
  if (!purged.ok) {
    db.updateReport({
      bootWarnings: [...db.bootReport.bootWarnings, { step: 'purge', error: purged.error }],
    });
  } else {
    db.updateReport({ purgedTombstones: purged.value });
  }

  return ok(db);
}

/**
 * `meta.schemaVersion` is only comparable when it is an integer >= 1 — the same
 * range `validateMeta` enforces. Anything else is corruption, not a version.
 */
function trustworthySchemaVersion(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}
