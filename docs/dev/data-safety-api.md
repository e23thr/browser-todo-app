# Data-safety API summary (E3, handoff from t_a7c2087f)

Implementation of **ADR-004** (`docs/adr/ADR-004-export-import-format.md`, BINDING) on top of the
ADR-002 storage framework (`docs/dev/storage-api.md`). Public surface: `src/portability/index.ts`.

**Every function returns `Promise<Result<T, ImportError | StorageError>>` — nothing throws across
the boundary, and `QUOTA_EXCEEDED` is always surfaced as the typed error (the §5.5 export/cleanup
dialog hangs off it — a write is NEVER silently dropped).**

## How to call it

```ts
import { bindDataSafetyDb, exportBackup, prepareImport, applyImport, /* … */ } from './portability';

const booted = await boot({ codec: adr004Codec }); // see "boot wiring" below
if (booted.ok) {
  bindDataSafetyDb(booted.value as AppDBImpl);     // once, at composition-root time
}
```

The ADR-004 signatures take no database argument; every function additionally accepts
`{ db }` (and usually `{ now }`) in its options for tests/explicit use.

## Export (M11, Decision 9)

```ts
exportBackup(opts?: { db?; now?; download?: boolean }): Promise<Result<ExportReport, ExportError>>
type ExportReport = {
  fileName: string;            // local-first-todo-backup-YYYY-MM-DDTHHmmssZ.json
  fileBytes: number;
  exportedAt: number;
  counts: { lists: number; tasks: number; snapshots: number };
  document: string;            // the EXACT bytes of the download (tests / re-import input)
  warnings: string[];          // e.g. 'settings.lastBackupAt not written back (QUOTA_EXCEEDED)'
};
```

- Full backup always: live rows AND tombstones; snapshot **metadata** only (payloads stay
  device-local); no filters/partial exports in MVP.
- `settings.lastBackupAt := exportedAt` in the document AND (best-effort) in the DB; that write
  failing never fails the export — it lands in `warnings`.
- `download: false` skips the browser download (used by tests); the filename helper is
  `backupFileName(exportedAt)`.
- Human-inspectable: pretty-printed 2-space JSON + trailing LF, fixed key order, canonical array
  sorts — double export differs only in `exportedAt`/`lastBackupAt` (stability property).

## Import (Decision 5) — prepare is pure, apply is confirmed

```ts
prepareImport(input: File | string, opts?: { migrations?; fileName?; })
  : Promise<Result<ImportPlan, ImportError>>        // stages 1-3, ZERO side effects
applyImport(plan: ImportPlan, opts?: { allowWithoutSnapshot?; db?; now?; })
  : Promise<Result<ImportReport, ImportError>>      // stages 5-7 (run ONLY after user confirm)
```

`ImportPlan` (show this in the confirm dialog — Decision 5.5's three facts are required copy):

```ts
{
  fileSummary: { fileName, fileBytes, formatVersion, schemaVersion, upgradedTo, kind };
  accepted: { lists: number; tasks: number; settings: boolean };
  quarantined: RecoveryEntry[];   // preview
  warnings: string[];
  records: { settings: Settings | null; lists: List[]; tasks: Task[] };  // internal
  recovery: RecoveryFile | null;                                          // internal
}
```

`ImportReport`:

```ts
{
  outcome: 'applied' | 'partial';          // 'partial' = applied with quarantined > 0
  accepted: { lists; tasks; settings };
  quarantined: number;
  recoveryFileName: string | null;         // present iff quarantined > 0 — offer the download
  recoveryFile: { filename; json } | null; // the file's bytes (never persisted anywhere)
  undoSnapshot: { id: string; takenAt: number } | null; // the pre-import snapshot
  warnings: string[];
}
```

UX obligations (binding, ADR-004 Decision 5.5): the confirm copy must state (a) this **replaces
ALL current data** with the file's counts, (b) an automatic **pre-import snapshot** is the undo
and lives in Settings → Storage → Snapshots (offer `downloadSnapshot(undoSnapshot.id)` — the
rolling-3 can evict it, the download is the durable escape hatch), (c) importing an old backup
can resurrect rows deleted since (tombstones are restored on purpose).

Import pipeline behavior worth knowing:

- Stage A rejects the WHOLE file (zero side effects): oversize (50 MiB before read), bad JSON,
  wrong `format` token (recovery files are refused with an explanatory message), `formatVersion`
  > 1 (`FORMAT_TOO_NEW`), `schemaVersion` > app target (`NEWER_SCHEMA`), depth > 8 or
  `__proto__`/`constructor`/`prototype` anywhere (`MALICIOUS_SHAPE`), structural caps (lists
  1 000 / tasks 100 000 / snapshots 1 000). Never `eval`/`Function`; records are whitelist-rebuilt.
- Stage B QUARANTINES per record (unknown fields, bad values, dangling `listId`/`parentTaskId`,
  cycles, duplicate ids — first occurrence wins) into the downloadable recovery document.
- Old exports (`schemaVersion` < target) upgrade through the SAME migration registry over the
  in-memory adapter (injectable via `opts.migrations`); failure = `UPGRADE_FAILED`, zero side
  effects.
- `NOTHING_TO_IMPORT` when every record quarantined (0 accepted) — a corrupt file is not an
  empty backup; a legit empty backup imports fine (replace-with-empty).
- Apply = ONE `readwrite` tx over `['lists','tasks','settings']`: hard-delete every existing row
  (quarantine-denylisted rows included — collected via `readUnfiltered`), then raw verbatim `put`.
  No re-stamping (future LWW depends on it). `meta` untouched (target `deviceId` wins). Snapshot
  stores untouched. On commit: theme mirror rewritten + `BroadcastChannel('local-first-todo')`
  `{type:'data-replaced'}`.

## Snapshots (M12, Decision 8)

```ts
takeSnapshot(reason: 'scheduled'|'pre-migration'|'pre-import'|'manual')
  : Promise<Result<{ id; takenAt }, StorageError>>   // manual keeps forever; others roll at 3
listSnapshots(opts?): Promise<Result<Snapshot[], StorageError>>   // newest first, metadata only
deleteSnapshot(id, opts?): Promise<Result<void, StorageError>>    // any kind, explicit user action
downloadSnapshot(id, opts?): Promise<Result<Blob, StorageError>>  // kind:'snapshot' document
snapshotDownloadName(snapshot): string                            // local-first-todo-snapshot-<UTC>.json
maybeScheduledSnapshot(opts?)                                     // ≤1 per 24h vs newest takenAt
prepareSnapshotRestore(id, opts?): Promise<Result<ImportPlan, ImportError>>  // zero-side-effect half
restoreSnapshot(id, opts?): Promise<Result<ImportReport, ImportError>>       // = full import of the payload
```

- Snapshot payloads ARE backup documents (`kind: "snapshot"`, `exportedAt === Snapshot.takenAt`),
  so **restore = import** and every rollback path is uniform.
- `restoreSnapshot(id)` runs the whole pipeline — including its own pre-import snapshot (undo of
  undo). UX confirm flows should use `prepareSnapshotRestore` → show plan → `applyImport`.
  Note: like any import, invalid rows quarantine to the recovery file instead of being restored.
- Retention (§8.2): rolling newest-3 `kind:'auto'` by `(takenAt, id)`, ALL `manual` kept;
  evict-then-put in one transaction (victims deleted first for quota headroom).
- `maybeScheduledSnapshot` is the boot trigger (§8.3): call it once after `boot()` succeeds —
  it no-ops (returns `ok(null)`) when the newest snapshot is < 24h old. Failure handling is the
  caller's (record a warning; boot continues).

## Wipe ("Delete all data", Decision 10 — the restore path depends on these semantics)

```ts
deleteAllData(opts?: { db?; storage? }): Promise<Result<void, StorageError>>
clearPrefs(storage?)   // todo:prefs:v1:* only (theme mirror → default)
```

Hard-deletes `lists`, `tasks`, `snapshots`, `snapshot_payloads` (denylisted rows included),
resets `settings` to `DEFAULT_SETTINGS_RECORD`, clears `todo:prefs:v1:*`, keeps `meta`
(`deviceId`, `createdAt`, `schemaVersion`; `lastPurgeAt` dropped). **NO pre-wipe snapshot** — a
snapshot there would be exactly the shadow copy §7.4 forbids.

## Recovery document (Decision 7)

```ts
serializeRecoveryDoc(entries, source, meta): string   // THE only writer (ADR-004 contract 5)
buildRecoveryDocumentFile(entries, source, meta): { filename, json }
```

`src/storage/quarantine.ts` (boot-validation quarantine) delegates to this same function — one
format, one writer. Files are `local-first-todo-recovery-<UTC>.json`, carry quarantined records
`raw` verbatim with `"field: reason"` issues, and are deliberately **not importable**.

## Error contract

```ts
type ImportError =
  | FILE_TOO_LARGE | PARSE_ERROR | NOT_A_BACKUP | FORMAT_TOO_NEW | NEWER_SCHEMA
  | UPGRADE_FAILED | MALICIOUS_SHAPE | LIMIT_EXCEEDED | NOTHING_TO_IMPORT | SNAPSHOT_FAILED
  | QUOTA_EXCEEDED | TX_ABORTED | UNAVAILABLE | UNKNOWN;
type ExportError = QUOTA_EXCEEDED | TX_ABORTED | UNAVAILABLE | UNKNOWN;
```

`applyImport` maps storage errors onto this union (`MIGRATION_FAILED` → `UPGRADE_FAILED`,
`NEWER_SCHEMA` passes through, the rest keep their code; unmapped codes surface as `UNKNOWN`
with the `StorageError` preserved as `cause` — nothing is swallowed).

## Cross-tab / theme side effects (Decision 3)

`mirrorTheme(settings)` rewrites the `todo:prefs:v1:theme` mirror from imported settings;
`broadcastDataReplaced()` posts `{type:'data-replaced'}` on `BroadcastChannel('local-first-todo')`.
Both are fire-and-forget, feature-detected, never throw.

## Test evidence (t_a7c2087f)

`tests/unit/portability/` — 65 tests over the ADR-004 testing contract: restore drill (byte-
equivalent records after export → wipe → import), stability (double export), old-export upgrade
through an injected registry (incl. `UPGRADE_FAILED`), malicious fixtures (oversize, truncated,
wrong token, `formatVersion`/`schemaVersion` too new, proto-pollution, depth bomb, count-limit
bomb, missing settings, all-records-corrupt) each rejected with zero side effects, quarantine and
referential drills (incl. cycles + cascade + tombstoned lists), duplicate ids, retention (rolling
3 autos, manual permanence, payloads evicted with rows), undo + undo-of-undo, snapshot-failure and
quota drills, snapshot-metadata-ignored, recovery-not-importable. Fixtures:
`tests/fixtures/backup/` (hostile inputs kept as raw text).
