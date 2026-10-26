# E10 QA — Encryption at Rest (C1) / ADR-007

**Card:** `t_0a8e0c42` — *Test: Encryption at rest & recovery flows (C1)*
**Reviewer:** `h_reviewer` · **Date:** 2026-10-26
**Impl under test:** commit `c1ed860` (65 files, +6945) + follow-up `fca1e79`, `ef0c987`
**Spec:** `docs/adr/ADR-007-encryption.md` (829 lines, normative) · handoff `docs/dev/encryption-api.md`

> Scope note: this is the **test** card, parallel to the **review** card `t_0913b7e4`
> (which returned REQUEST CHANGES with 7 blockers). Findings below were derived
> first-hand from the spec and the code — not inherited from that review. Where the
> two overlap, that is corroboration, and each overlap is marked *(independently
> confirmed)*. Two findings below are **new** and were not in the review.

---

## 1. Verdict

**CONDITIONAL PASS — 5 defects (2 blocking / 3 confirmations of the review's blockers), 1 candidate withdrawn as a test-double artifact.**

Every core cryptographic claim in ADR-007 holds. No plaintext leak, no silent data
loss, and no cryptographic weakness was found. The defects are **wiring and
integration** defects: the crypto is right, but two product flows cannot be reached
and encrypted multi-device sync breaks after one round trip.

| Area | Verdict | Basis |
|---|---|---|
| AES-GCM / PBKDF2 / HKDF primitives + parameters | **PASS** | 4 KAT vectors verified **twice independently** (§3), on Node/OpenSSL *and* Chromium WebCrypto |
| Key lifecycle (memory-only, re-lock on idle) | **PASS** | service + lock suites, first-hand re-run |
| Forced-backup gate (cannot enable without export) | **PASS** | gate reads a **real** `exportBackup` receipt end-to-end (§4 Q1) |
| Migration + QUOTA pause/resume + rollback | **PASS** | real fault injection, previously untested branch now covered (§4 Q2/Q5) |
| Corrupt-ciphertext quarantine, no silent loss | **PASS** | leak audit on the recovery file (§4 Q8) |
| Encrypted record at rest / export warning | **PASS** | byte-level leak audit in unit **and** Chromium (§4 Q1, §5) |
| Import / restore into an encrypted store | **PASS (browser)** | **proved in Chromium**, not in the double (§5) |
| Two-device sync convergence under C1 | **FAIL** | `E10-Q4` + `E10-Q5` (§6) — blocking |
| Recovery / lost-passphrase UX reachability | **FAIL** | `E10-Q1` + `E10-Q2` + `E10-Q3` (§6) — blocking |

---

## 2. Test matrix

Legend: ✅ verified first-hand · 🔴 defect pinned as `it.fails` · ➖ covered by impl suite, re-run green

| # | ADR-007 requirement | Probe | Result |
|---|---|---|---|
| 1 | WebCrypto AES-GCM known-answer vectors (contract 1) | `tests/unit/crypto/kat.test.ts` (re-run) | ✅ 3 vectors + AAD/tamper negatives |
| 2 | …verified with a *different* implementation | `scratch/e10-kat-verify.py` (Python `hashlib`/`hmac`, OpenSSL-backed) | ✅ **all MATCH** (§3) |
| 3 | …verified on the *shipping* WebCrypto | `tests/e2e/e10-encryption.spec.ts` → Chromium | ✅ 4 vectors + 2 negatives (§3) |
| 4 | PBKDF2-HMAC-SHA-256, 600,000 iters, 16-byte salt | KAT `B` + `passphrase.ts` floor | ✅ |
| 5 | HKDF-SHA-256 `info=todo-enc/1/recovery-kek` | KAT `C` | ✅ |
| 6 | DMK wrap/unwrap + slot/keyId binding (AAD) | KAT `D` + `WRONG_KEY_DOMAIN` negatives | ✅ |
| 7 | Tampered ciphertext → GCM tag failure, never partial read | KAT `E` | ✅ |
| 8 | Key never persisted in plaintext; session-only memory | `vault-edges` + leak audit (§4 Q8) | ✅ |
| 9 | Re-lock on idle (5/15/30/60) + toast + locked screen | `lock.test.ts` (re-run) | ➖ green |
| 10 | Forced backup gate: enable without export impossible | **Q1** real `exportBackup` → `backupGate` | ✅ new (§4) |
| 11 | Stale receipt (pre-wizard) rejected | **Q1** boundary probe | ✅ new |
| 12 | Optional recovery key: offered, round-trip works | `passphrase-recovery` + service | ➖ green |
| 13 | Sweep QUOTA pause → typed, resumable | **Q2** real `armQuotaAfter()` injection | ✅ new (§4) |
| 14 | Mixed store legal; no half-written row | **Q2** batch atomicity check | ✅ new |
| 15 | Crash mid-sweep resumes on unlock (D7.1) | **Q1-pin** `E10-Q1` | 🔴 defect |
| 16 | Enable failure leaves store plaintext (D6.1) | **Q5** snapshot-failure + keyring-failure branches | ✅ new (both branches previously untested) |
| 17 | Recovery slot never orphaned (D6.1 order) | **Q5-pin** `E10-Q2` | 🔴 defect |
| 18 | Pre-migration snapshot exists, wrapped at rest (D4.4) | **Q6** real (unstubbed) default path | ✅ new |
| 19 | Restore refuses TYPED while locked (D4.4) | **Q6** | ✅ new |
| 20 | Restore/rollback works into an encrypted store | **browser drill** `pre-migration snapshot restore` | ✅ §5 (double artifact, see §7) |
| 21 | Import re-encrypts on write, no plaintext path (D4.5) | **browser drill** 4/4 rows ciphertext | ✅ §5 |
| 22 | Ciphertext never leaks to console | grep `console.(log\|warn\|error\|debug)` over `src/crypto` | ✅ **0 matches** |
| 23 | Recovery file carries ciphertext only | **Q8** quarantine leak audit | ✅ new |
| 24 | Purge explicit, never automatic | **Q8** | ✅ new |
| 25 | Wire carries no plaintext (sync) | **S1** byte scan of every pushed file | ✅ new |
| 26 | Two devices converge; conflict copies decrypt | **S2** one-way pull | ✅ first hop only |
| 27 | Second version / round trip converges | **S2b-pin** `E10-Q5` | 🔴 defect |
| 28 | Encrypted task pushed with correct wire kind | **S1b-pin** `E10-Q4` | 🔴 defect |
| 29 | Mixed-key foreign device defers non-destructively (D3.3) | **S3** | ✅ new |
| 30 | Device join via key file (D3.2) | **Q9-pin** `E10-Q3` | 🔴 defect |

---

## 3. Vector evidence (independent verification)

The impl's KAT fixtures could in principle be self-referential (generated and
checked by the same library). Verified **three ways**:

### 3a. Python / OpenSSL — independent of the implementation

`~/.hermes/profiles/h_reviewer/cache/scratch/e10-kat-verify.py` reproduces the
vectors from the raw parameters with `hashlib`/`hmac` (OpenSSL-backed), calling
**none** of the repo's crypto:

```
PBKDF2-HMAC-SHA-256  pass='correct horse battery staple'  salt=00..0f  iters=600000  dkLen=32
  expected ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6
  actual   ef177144eec9420cbc1093d2a8b344a92bc506d0d4ec9c028dd19f8324d8c1e6   MATCH

HKDF-SHA-256         ikm=20..3f  salt=''  info='todo-enc/1/recovery-kek'  len=32
  expected f96b403d739bb69112d33ddc808301fbd04515fefdd2220bf8d7dd4afdd46d2f
  actual   f96b403d739bb69112d33ddc808301fbd04515fefdd2220bf8d7dd4afdd46d2f   MATCH
```

The AES-GCM seal and DMK-wrap vectors were additionally cross-checked by an
independent AES-GCM implementation (`e10-kat-verify.py`, exit 0). **The fixtures
are genuine known-answer vectors, not the implementation asserting itself.**

### 3b. Node WebCrypto (impl suite, re-run)

`tests/unit/crypto/kat.test.ts` — 3 vectors + AAD-swap + slot-transpose + keyId
+ tamper negatives: **green**.

### 3c. Chromium WebCrypto (real browser, this card)

`tests/e2e/e10-encryption.spec.ts` runs the same vectors against **Chromium's own**
WebCrypto (`crypto.subtle`), because a Node-only pass cannot rule out a quirk
shared by both sides of the same engine:

```
A_aes_gcm_seal        pass  iv + ct match the pinned bytes
A_aes_gcm_open        pass  pinned ct → exact plaintext
B_pbkdf2_600k         pass  ef177144eec9420cbc1093d2a8b344a9…c1e6  (identical to §3a)
B_kek_shape           pass  AES-GCM, extractable=false
C_hkdf_recovery       pass  f96b403d739bb69112d33ddc808301fb…6d2f  (identical to §3a)
C_recovery_kek_shape  pass  AES-GCM
D_wrap_pinned         pass  wrap ct matches pinned bytes
D_slot_binding        pass  recovery/keyId transposition → WRONG_KEY_DOMAIN
E_aad_and_tamper      pass  id swap, kind swap, bit-flip all refused
```

**Digests are byte-identical across Python/OpenSSL, Node, and Chromium.**

---

## 4. Failure paths degrade without silent data loss

Each path was driven first-hand with **real** fault injection (the impl's own
suite stubs the happy path in several of these — noted where relevant).

### Q1 — Forced-backup gate reads a *real* export receipt ✅

The impl's `vault-service.test.ts` seeds `settings.lastBackupAt` **by hand**,
which proves the check but not the loop. This probe closes it:

```
exportBackup({db, now, download:false})  → ok, document contains 'Buy milk'
  backupGate(db, exportedAt - 1)  → ok            (receipt inside the flow window)
  backupGate(db, exportedAt + 1)  → NO_BACKUP     (export finished before the wizard opened)
```

Gate is mechanical: `service.ts` `backupGate` runs **before** any other work and
returns `NO_BACKUP` first. Not bypassable from the service surface.

### Q2 — QUOTA mid-sweep: typed pause, resumable, nothing half-written ✅

**Previously untested**: `migrate.test.ts` has a QUOTA case that injects **no
fault** (the file admits it in a comment), and `grep 'ok: false'` over
`tests/unit/crypto` returned **0** — every `takePreMigrationSnapshot` stub returns
`{ok:true}`.

This probe arms a put budget (`armQuotaAfter(3)`, same `quotaError()` shape the
storage suite uses) so the failure lands **inside the sweep**:

```
runSweep(batchSize 2)      → QUOTA_EXCEEDED  (typed, not a crash)
state                      → status 'migrating', migration.direction 'encrypt'
sweepRemaining('encrypt')  → 2 of 4
per-row audit              → every row either valid plaintext or fully decryptable
                             (batch atomicity: no hybrid/half-written row)
resumeMigration()          → ok; sweepRemaining → 0; status → 'on'
repeat sweep               → skipped == total (idempotent)
```

**No silent data loss**: bytes stay readable in both states; resume is a fresh scan.

### Q5 — Enable failure branches (both previously untested) ✅

| Branch | Before | Now |
|---|---|---|
| Pre-migration snapshot fails | **0 tests** | store stays `off`, keys `[]`, rows untouched plaintext |
| Keyring persist fails (quota on state write) | **0 tests** | `MIGRATION_FAILED`, status `off`, keys `[]`, no record touched |
| Sweep fails after recovery opt-in | 0 tests | 🔴 `E10-Q2` pin |

### Q6 — Pre-migration snapshot: real path, wrapped at rest ✅

Unstubbed `enableEncryption` (production default) — the impl always stubs this:

```
snapshots row reason='pre-migration'      exists
snapshot_payloads[payload]                format='todo-enc/1', does NOT contain 'pre-alpha'
restore while UNLOCKED                    original titles recovered (browser: §5)
restore while LOCKED                      LOCKED (typed) — never garbled/partial
```

### Q8 — Quarantine leak audit ✅

Tampered ciphertext → row excluded from app reads, **bytes kept verbatim**,
recovery file contains the ciphertext record **without** the title
(`json ⊄ 'super secret title'`), quarantine metadata likewise clean, purge is
explicit and announced. No automatic deletion anywhere.

---

## 5. Real-browser evidence (Chromium, real IndexedDB + WebCrypto)

Because the ADR's contract is a *browser* contract, and because a test double can
lie, the following were run in a real Chromium page against the production engine
(`tests/e2e/e10-encryption.spec.ts` + `tests/e2e/encryption/harness.ts`,
4/4 passing):

| Drill | Result |
|---|---|
| KAT on Chromium WebCrypto | ✅ 4 vectors + 2 negatives (§3c) |
| IndexedDB tx lifetime: microtask survives, macrotask → `InvalidStateError` | ✅ spec-faithful |
| **Enable C1 → row ciphertext at rest, no plaintext title in bytes** | ✅ leak audit |
| **Seamed tx + async WebCrypto does not break the write** | ✅ `seamedThrow = null` |
| **Import 4 plaintext records into an encrypted store** | ✅ `4/4 rows ciphertext`, 0 quarantined, no plaintext title at rest |
| **Pre-migration snapshot restore of a non-empty encrypted store** | ✅ content back, `encrypted == tasks`, status `on` |

Run with: `npx playwright test --config tests/e2e/e10-encryption.playwright.config.ts`
(app-server-free; see §7 for why the main config's `webServer` was unusable here).

---

## 6. Defect list

> Pins follow the repo's E9 convention: `it.fails`, body asserts the **desired**
> behaviour, so the suite stays green while the defect exists and turns red the
> moment it is fixed.

### 🔴 E10-Q4 — BLOCKING — encrypted tasks are pushed with the wrong wire `kind`

*New — not in the review card.*

> **RESOLVED — fix card t_10f00447.** `toSyncRecord` now derives the envelope
> kind with `rowKindOf(row)`. The pin below was flipped from `it.fails` to a
> plain `it`, and a new regression suite (`describe 'push envelope — wire kind
> self-description'` in the same file) decodes a real `runSyncOnce` push and
> asserts the wire `kind` against the at-rest row's own `kind` for BOTH stores,
> on the first push and the re-push — the coverage gap named below is closed.

`src/sync/engine.ts:103` (`toSyncRecord`):

```ts
kind: 'title' in row ? 'task' : 'list',
```

An `EncryptedTaskRecord` has **no top-level `title`** (`domain/model.ts:164-184` —
the title lives inside the encrypted payload), so every encrypted **task** is
published as `kind: 'list'`. The record already self-describes correctly
(`kind: 'task'` at `model.ts:166`), and the repo already has the right helper —
`rowKindOf()` at `model.ts:217` does `if (isEncryptedRecord(row)) return row.kind;`.
`toSyncRecord` simply does not use it.

Direct wire decode:

```
MY TASK ID: MY19J87V02XXYC3FC6SHAGZ3RA
  WIRE id=MY19J87V02XXYC3FC6SHAGZ3RA wireKind=list record.kind=task isMyTask=true
```

**Fix:** `kind: rowKindOf(row)` (one line). Note the *apply* path already uses
`rowKindOf` (`engine.ts:309`, `:353`) and is therefore correct — only the push
envelope is wrong, which is why a first pull lands in the right store while a
second one explodes.

### 🔴 E10-Q5 — BLOCKING — second sync round permanently fails (`CORRUPT_REMOTE`, non-retryable)

*New — not in the review card. Consequence of E10-Q4.*

> **RESOLVED — fix card t_10f00447** (same one-line root cause). Two notes for
> whoever reads the pin: (1) its edit step had spliced a plaintext `title` onto
> the raw ciphertext row — the write seam stores already-encrypted rows VERBATIM
> (ADR-007 D4, tombstone-while-locked), so that produced a *hybrid* row that
> `validateRow` refuses on the receiving side (`title: unknown (unexpected
> field)`). The pin now edits through the app surface (`db.get` → domain view →
> `db.put` → re-encrypt), which is what a user edit does. (2) With the fix the
> round trip converges with **no** conflict copy: A's follow-up edit is not a
> concurrent divergence (LWW `only-remote-changed`), so the pin asserts clean
> convergence plus a working 2nd and 3rd round on A instead of a copy.

`merge.ts:177` compares the local entry kind (from the `tasks` store → `'task'`)
against the wire kind (`'list'`) and refuses:

```ts
if (entry.kind !== sr.kind) return err({ code: 'CORRUPT_REMOTE', …, retryable: false });
```

Reproduced with the sync test double (two real `AppDB`s, `makeFakeWebDav`,
**plaintext second device** — so no key-join preconditions are needed):

```
A r1: ok
B r1 (plaintext): ok          ← pulls A's ciphertext, echoes it back
A r2: {"code":"CORRUPT_REMOTE","message":"remote mixes kinds for record XKJ6…","retryable":false}
A r3: {"code":"CORRUPT_REMOTE", …}   ← never recovers: cursor never advances
```

Also reproduced with two C1 devices sharing a key (`joinWithKeyFile`), and pinned
as `it.fails` in `tests/unit/sync/e10-encrypted-convergence.test.ts`.

**Impact:** encrypted multi-device sync works for exactly one hop, then the
originating device cannot sync again — no retry, no self-heal. This defeats the
epic's own AC *"encrypted records converge correctly under LWW sync"*.

**Why the impl suite missed it:** `encrypted-merge.test.ts` tests `planMerge` with
hand-built inputs (`fetched: [{ kind: 'task', … }]` — 8 occurrences) and never
calls `toSyncRecord`; the engine tests (`engine.test.ts`) are plaintext-only, where
`'title' in row` happens to be right. **No test drives an encrypted row through the
push envelope.**

### 🔴 E10-Q1 — BLOCKING — `resumeMigration` has no production caller *(independently confirmed)*

Exported at `src/crypto/service.ts:253`; repo-wide grep finds only test callers.
ADR-007 D7.1 requires a boot/unlock with `status: 'migrating'` to resume the sweep.
A crash or QUOTA pause mid-enable therefore strands the store in `migrating`
forever: `enableEncryption` refuses (`ALREADY_ENABLED`), the Turn-off button is
hidden (`status !== 'on'`), and the status line reads "Encrypting your data…"
indefinitely. The resume API itself works when called (control test in the same
file passes), so this is purely a **wiring** gap.

### 🔴 E10-Q2 — BLOCKING — turn-off hardcodes an empty passphrase *(independently confirmed)*

`src/features/crypto/CryptoSection.tsx` passes `passphrase: ''` to
`disableEncryption`. `verifyPassphrase` performs a **real** ring check (no
shortcut), so the button always fails with `UNLOCK_FAILED`. No test covers this
button (`grep turnOff|turn.off tests/` → 0) and no component test renders
`CryptoSection`/`EnableWizard`/`UnlockDialog`/`LockedScreen` (0 files).
ADR-007 D6.2 requires passphrase confirmation.

### 🔴 E10-Q3 — BLOCKING — device join leaves the store `status: 'off'` *(independently confirmed)*

`joinWithKeyFile` adopts the foreign key into the ring but only patches `keys` —
`status` stays `'off'`, so `lockState` stays `disabled`. Consequences on a joined
device: no locked screen, `writeRow` stores **new user text in plaintext**
(`status === 'off'` → passthrough), and after a reload `unlockWithPassphrase`
refuses (`NOT_ENABLED`) — the device cannot use the key it just imported. Compounded
by the review's finding that `joinWithKeyFile` has **zero production callers** (no
join UI exists), so D3.2's flow is unreachable end to end.

### ⚪ E10-Q6 — WITHDRAWN — "import/restore into an encrypted store fails" was a test-double artifact

Honesty note: this started as a candidate blocking defect. Under `fake-indexeddb`,
`applyImport`'s seamed `db.tx` fails with `UNAVAILABLE / InvalidStateError`
because awaiting `crypto.subtle` inside a live transaction deactivates it **in that
double**. I did not report it, because it was a browser claim — so I measured the
double against the browser:

| Await inside a live `readwrite` tx | fake-indexeddb | Chromium |
|---|---|---|
| resolved promise (microtask) | survives | survives |
| `queueMicrotask` | survives | survives |
| `setTimeout(0)` (macrotask) | `InvalidStateError` | `InvalidStateError` |
| `crypto.subtle.digest` | **`InvalidStateError`** | **survives** (resolves as a microtask) |

Chromium keeps the transaction alive for the product's actual crypto await, and the
real drills pass (§5): import writes 4/4 ciphertext rows, restore recovers a
non-empty encrypted store. **The unit probe was wrong about the product.** The unit
test now asserts only what the double can settle (snapshot exists, wrapped at rest,
locked restore refuses typed) and documents the divergence in place; the restore
assertion lives in the browser spec.

---

## 7. Notes, coverage gaps and environment

- **KDF floor / lazy upgrade coverage is thin** (`upgradedSlot|floorIters|preLock`
  over `tests/` → 6 matches). Non-blocking; worth a follow-up test, not a defect.
- **No crypto E2E existed** before this card (`grep -rln 'crypto|encrypt|passphrase'
  tests/e2e/` → nothing crypto-specific). This card adds the first one.
- **Leak audit:** `grep -E 'console\.(log|warn|error|debug)' src/crypto` → **0
  matches**. No user text in crypto error strings.
- **Build/red CI is sibling work, not encryption:** `npm run build` (= `tsc -b`) is
  red from in-flight recurrence edits (`src/domain/recurrence.ts` untracked,
  `src/features/tasks/*` modified, `TaskPort` interface) — recorded as
  `preexisting_not_mine` in the impl handoff. My files: **0 typecheck errors,
  eslint `--max-warnings 0` clean, Prettier clean.**
- Because the app `webServer` needs that red build, this card ships
  `tests/e2e/e10-encryption.playwright.config.ts` — an app-server-free entry point
  (the drills serve their own vite-built harness, same pattern as
  `data-safety-journey.spec.ts`). The spec is still picked up by the standard
  `npm run e2e` via `testDir: './tests/e2e'` once the tree is clean.

---

## 8. Evidence artefacts

| Artefact | Path |
|---|---|
| Independent KAT verifier (Python/OpenSSL) | `~/.hermes/profiles/h_reviewer/cache/scratch/e10-kat-verify.py` |
| Unit probes (11 tests: 8 pass + 3 defect pins) | `tests/unit/crypto/e10-qa-probes.test.ts` |
| Sync convergence probes (5 tests: 3 pass + 2 defect pins) | `tests/unit/sync/e10-encrypted-convergence.test.ts` |
| Real-browser drills (4/4) | `tests/e2e/e10-encryption.spec.ts` |
| Browser harness (KATs, tx-lifetime, import/restore) | `tests/e2e/encryption/harness.ts` |
| App-server-free Playwright config | `tests/e2e/e10-encryption.playwright.config.ts` |
| This report | `docs/qa/e10-encryption.md` |

**Re-run:**

```bash
npx vitest run tests/unit/crypto/e10-qa-probes.test.ts \
                tests/unit/sync/e10-encrypted-convergence.test.ts
python3 ~/.hermes/profiles/h_reviewer/cache/scratch/e10-kat-verify.py
npx playwright test --config tests/e2e/e10-encryption.playwright.config.ts
```

---

## 9. RESOLVED notes (append-only — fixes landed on card t_758ed741)

The three remaining `it.fails` defect pins were flipped to plain `it(...)` by
the fix card (same convention as §Q4/Q5's flip). Baseline before the fixes:
`28 passed | 3 expected fail`; after: **`41 passed (0 expected fail)`** on
`{e10-qa-probes, vault-service, migrate, vault-edges}`.

| Pin | Fix | Where |
|---|---|---|
| **E10-Q1** (D7.1 "resume on next unlock" had no caller) | `unlockWithPassphrase/…KeyFile/…RecoveryCode` resume the migrating sweep in-line before resolving; `refreshAfterUnlock` retries via the single-flight `resumeMigrationFlow` (quota dialog → one retry); progress/paused ride the `migrationRun` signal; sweeps are process-wide single-flight | `src/crypto/{vault,service}.ts`, `src/features/crypto/wiring.ts`; `tests/unit/crypto/boot-resume.test.ts` covers the wiring path (`initCryptoForApp` + unlock/refresh, never `resumeMigration` directly) |
| **E10-Q2** (sweep failure stranded an undisclosed recovery slot) | The slot is no longer minted into the key ring: headless callers get it issued only after a SUCCESSFUL sweep; the wizard gets the D6.1 order structurally — material disclosed before the sweep, slot persisted only on the "I saved it" ack | `src/crypto/service.ts` (`onRecoveryOffer` seam); `tests/component/enable-wizard.test.tsx` (code on screen with zero rows encrypted + no slot; ack persists it) |
| **E10-Q3** (fresh-store join left `status: 'off'` — locked screen never shows, writes stay plaintext, reload bricks) | `joinWithKeyFile` flips a fresh store to `status: 'on'` (zero record re-encryption stays D3.2's rule) and calls `clearDecryptQuarantine()` so pre-join foreign rows heal under the adopted key (D3.3, deviation #10's missing caller); the blocked signal clears | `src/crypto/vault.ts`; `tests/unit/crypto/join-heal.test.ts` (quarantine → join → readable + signal cleared) |
