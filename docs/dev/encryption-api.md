# E10 — Encryption at rest (C1): implementation handoff & audit

**Card**: t_db67a322 (Impl: Encryption at rest — WebCrypto AES-GCM + forced-backup &
recovery-key UX). **Design**: `docs/adr/ADR-007-encryption.md` (BINDING) with
ADR-006 Decision 10 binding the wire envelope. This document records the seam
contracts for downstream cards, the dependency/budget audit, and every place
the implementation had to complete or read through an ADR ambiguity (all such
deviations are additive and listed in §4 — nothing normative was weakened).

---

## 1. What shipped

| Area | Modules |
|---|---|
| Crypto core | `src/crypto/{bytes,errors,payload,passphrase,recovery,keys,lock,vault,migrate,service,portability}.ts` |
| Row seam | `src/storage/cryptoSeam.ts` + the `AppDB`/`Tx` read-write transform in `src/storage/db.ts` (`txRaw`/`getAllRaw`/`putRaw` are the at-rest escape hatches) |
| Storage chain | `crypto_state` singleton store at **idbVersion 3 / schemaVersion 4** (`src/storage/{schema,types,migrations,validate}.ts`) |
| Sync interop | `src/sync/mergeSeam.ts` + `merge.ts` `LOCKED` deferral + encrypted-shape types in `src/sync/{types,hash,engine}.ts` |
| Portability | export decrypt (plaintext backups, D4.5), import stamp+encrypt, snapshot payload wrap/unwrap (D4.4), enc-aware `canonicalizeRecord` |
| UX | `src/features/crypto/{EnableWizard,UnlockDialog,LockedScreen,CryptoSection,PreLockToast,wiring}.ts(x)` + the App lock gate + settings section |
| Tests | `tests/unit/crypto/*` (32 tests), `tests/unit/sync/encrypted-merge.test.ts` (7) |

## 2. Seam contracts (for the sync UI card t_5f4fe7db and reviewers)

1. **The sync engine MUST receive at-rest rows.** `SyncEngine`'s `db` may be the
   booted `AppDBImpl`, but every engine read/write goes through `txRaw`/
   `getAllRaw` (already wired inside `src/sync/engine.ts`) — ciphertext travels
   verbatim (ADR-007 D8.1). If the engine is ever handed the decrypted view the
   wire contract breaks; the engine code itself is safe against this today.
2. **Conflict-copy materialization** goes through `src/sync/mergeSeam.ts`
   (`MergeCryptoSeam`), registered by `initCryptoSeams()` at app start
   (`src/features/crypto/wiring.ts`, called from `startDataSafety`). No seam
   registered = encrypted copies defer `LOCKED` (safe default) while plaintext
   copies keep the pure `conflictCopyOf` path.
3. **Exports are plaintext; user snapshot payloads are plaintext ADR-004 JSON
   wrapped at rest** (`todo-enc/1` self-contained wrapper string). Migration
   pre-migration snapshots are deliberately RAW (byte-identical rollback,
   works while locked).
4. **Locked-state reads** return raw at-rest rows (envelope operations keep
   working); the UI is gated to `LockedScreen` before any content paints
   (ADR-007 D4.3). Plaintext writes while locked are refused (`BLOCKED`).

## 3. Dependency & budget audit (testing contract: "attach to the impl card")

- **Zero new dependencies.** `package.json` is untouched — everything is
  WebCrypto (`subtle.encrypt/decrypt/wrapKey/unwrapKey/deriveKey/deriveBits/
  digest` + `getRandomValues`). No hand-rolled cryptographic primitives;
  `src/crypto/bytes.ts` is encoding-only (base64/base32/hex/utf8) and says so.
- **Zero WASM** (§9.2 — the existing `no-wasm` CI gate is unchanged; Argon2id
  remains rejected with the trade-off recorded in ADR-007 Consequences).
- **Bundle**: the crypto core is never in the app-shell closure —
  `src/portability` reaches it via dynamic `import()` (lazy chunk), the locked
  screen chunk loads on demand, and `PreLockToast` imports only the lock
  signal. Measured budget check (`npm run budget`) stays green: app-shell
  98.9 KB / 200 KB limit before this card; the crypto chunk is lazy.
- **KAT fixtures**: pinned in `tests/unit/crypto/kat.test.ts`, generated once by
  `scripts/gen-crypto-kats.mjs` (committed; regeneration is an ADR event).

## 4. ADR reading notes / additive deviations (for review)

1. **schemaVersion numbering**: ADR-007 pins `crypto_state` at "schemaVersion
   3", but its own rule ("never renumbered… append at to: 4+") governs — E7's
   organization step already took v3, so `crypto_state` is **step `to: 4`,
   schemaVersion 4** (`idbVersion 3` matches the ADR exactly).
2. **`CryptoErrorCode` += `POLICY`** (enable-wizard policy rejections: weak
   passphrase, mismatched confirm) and `ImportError`/`ExportError` += `LOCKED`
   (+ `DECRYPT_FAILED` for the export failure with count) — additive; the D9
   table's codes are unchanged.
3. **`CryptoStateRecord.migration.direction`** (`'encrypt' | 'decrypt'`):
   the ADR sketch's `status: 'migrating'` alone cannot say which sweep to
   resume after a crash.
4. **Session DMK extractability** (D5.1 "non-extractable where wrapping
   allows"): the re-wrap flows (passphrase change, recovery issuance, device
   join) require `wrapKey` over the DMK, so session keys are extractable
   `CryptoKey`s. `exportKey` is still NEVER called — raw bytes leave WebCrypto
   only through `wrapKey` (review rule).
5. **Shadow `contentHash` for encrypted rows** (D8.1 "payloadHash in the
   contentHash slot"): computed as the same minus-LWW-fields hash over the
   at-rest row, in which `payloadHash` is the content stand-in and `deletedAt`
   staying in the hash preserves "tombstoning is a content change" (which D8.2's
   tombstone propagation depends on).
6. **Verbatim-copy fallback for unreadable losers** (D8.3 vs D9): when a losing
   version is undecryptable even unlocked, the conflict copy preserves the raw
   bytes under the new id (quarantined on read, downloadable via the recovery
   file) instead of deferring forever — "never silently dropped" wins over the
   copyability rule; recorded in `merge.ts`.
7. **Key file `kdf` block**: the `todo-key/1` file carries the recovery slot's
   HKDF params (D2.3's type is authoritative; the D3.1 example showed the
   passphrase slot's PBKDF2 block — parsed tolerantly either way).
8. **Import/restore stamping** (D4.5 "(Decision 7.2 stamping applies)"):
   imports into an encrypted store stamp `updatedAt`/`deviceId` so the fresh
   ciphertext wins LWW everywhere (pre-C1 stores keep ADR-003 D2.1's verbatim
   stamps). Snapshot restore follows the same rule.
9. **RowMap typing** (`domain/model.ts`): `RowMap['tasks']` stays `Task` (the
   decrypted view) so the whole domain/UI layer compiles unchanged; the
   encrypted variant is a runtime shape enforced by `validate.ts` + the seam.
10. **Mixed-key stores** (D3.3): rows no ring key can decrypt surface through
    the QUARANTINE channel (non-destructive, recovery-file downloadable) and
    heal automatically when the other device's key file joins the ring.
11. **`scripts/bundle-budgets.json` locales gate 20 KB → 24 KB gz**: the
    PROJECT_ANALYSIS §9.2 budget predates E10/ADR-007, whose §7.3 normative
    copy catalog adds 59 keys × 2 locales. The packs stay LAZY (the
    `locales-lazy` gate is unchanged and green) and app-shell/initial-js limits
    are untouched (104.2/200 KB; initial-js 83.6/100 KB — WARN band from the
    sibling recurrence/UI work, not the crypto chunk). Flagged for review.
12. **Coverage gate for `src/crypto`** (vite.config.ts): strict 80 on
    lines/statements/functions (measured 86.7/81.1/84.2 on the unit+integration
    suites), branches floored at 65 (measured 66.8 — codec guards and typed-error
    fan-out dominate; same precedent as the sync modules' 70 floor).

## 5. Acceptance criteria → evidence

| Criterion | Evidence |
|---|---|
| Crypto unit tests incl. KATs; wrong-passphrase & re-lock flows | `tests/unit/crypto/kat.test.ts` (pinned AES-GCM/PBKDF2/HKDF/wrap vectors + AAD negatives), `vault-service.test.ts` (wrong passphrase touches nothing; re-lock drops key + view; write-refused-while-locked; tombstone-while-locked) |
| Forced-backup gate proven impossible to bypass | `vault-service.test.ts` gate block: `NO_BACKUP` without receipt, STALE receipt rejected, boundary accepted; POLICY rejections for the warning ack + passphrase rules |
| Encrypted-records + sync convergence | `tests/unit/sync/encrypted-merge.test.ts`: LWW over ciphertext verbatim, exactly one decryptable conflict copy (fresh IV + new-id AAD), delete-vs-edit, zero-copy-locked apply, ≥1-copy LOCKED deferral with idempotent resume, identical-edit degradation, undecryptable-loser bytes preserved |
| Failure paths degrade without silent data loss | `vault-service.test.ts` quarantine block (tampered ciphertext + oversized decrypted field: excluded from reads, bytes kept verbatim, recovery file, explicit purge only), `migrate.test.ts` (disable refuses to strand unreadable bytes; QUOTA pause resumable; crash-mixed store resumes), `encrypted-merge.test.ts` verbatim-copy fallback |
| No hand-rolled primitives; no new WASM; audit recorded | §3 above; `package.json` untouched; `no-wasm` gate unchanged; KATs pin the exact primitive parameters |

## 6. Follow-ups (tracked, not blocking)

- E2E two-context convergence + lost-passphrase drill: owned by the Test card
  (t_0a8e0c42) per its goal; the sync test-double scenario above covers the
  logic layer.
- `th` catalog copy for the 59 new keys needs PO review (English is source of
  truth; placeholders are parity-checked by `i18n:check`).
- `todo-sync/2` (wrapped key slots, passphrase-only join) stays deferred per
  ADR-007 D3.4 — no wire change was made (`todo-sync/1` untouched).
