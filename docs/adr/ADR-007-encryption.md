# ADR-007: Encryption at rest (C1 — stretch)

**Status**: Accepted
**Date**: 2026-10-23
**Author**: h_senior_coder (sole decider per task t_55accc9c — single-decider rule; the ONLY card
that may design crypto)
**Scope**: Local-First Todo Web App (GitHub Pages static PWA). Epic E10 (stretch, Q3) Encryption at
Rest. This is the crypto design ADR (docs only); implementation is a separate gated card.
**Refs**: PROJECT_ANALYSIS.md §7.3 (encryption at rest + NON-NEGOTIABLE UX constraints), §7.1–7.2
(threat model, WebCrypto-only policy), §12 Q3 (PO DECIDED: stretch, "schema stays
encryption-ready"), §6.2 (sync/conflict policy), §11 R7 (lost-passphrase risk), §9.2 (bundle
budgets — **0 WASM**), §5.4 (migrations), §7.4 (portability/deletion); ADR-002 (storage schema,
migration chain, Result contract), ADR-003 (search index, tab protocol), ADR-004 (export/import
container), ADR-006 (WebDAV sync — **Decision 10 envelope is binding on this ADR**).

---

## Context

C1 protects **task/list content at rest in the browser origin** against the threat model's case
(c), **shared-device snooping** (§7.1). It does not and cannot defend against an attacker with
full browser-profile access plus the passphrase, nor against a compromised runtime (§7.1 states
the boundary honestly; §7.2's no-third-party-code policy is what keeps the runtime trustworthy).

Constraints this ADR records and does not re-litigate:

1. **§7.3 verbatim (non-negotiable UX — record, do not weaken):**
   > Passphrase → KDF (PBKDF2 native; Argon2 = WASM cost) → AES-GCM per-record or store-level
   > encryption of titles/notes; key held in memory per session, re-lock on idle. (Attachments do
   > not exist — PO Q7.)
   > **Non-negotiable UX constraints if built:** enabling it forces a backup export first, warns
   > explicitly that a lost passphrase means unrecoverable data, and offers an optional recovery
   > key.
2. **WebCrypto only, no hand-rolled primitives** (§7.2). **WASM budget = 0** (§9.2) and the
   exception "will not be granted" (task body): the KDF is **PBKDF2 (native)**, not Argon2id.
3. **ADR-006 Decision 10 is binding** (plaintext merge envelope + `payloadHash`; LWW/tombstones
   run without keys; content merge/conflict copies require the key unlocked, `LOCKED` deferral
   otherwise; degraded identical-edit detection; and the explicit AAD-vs-verbatim-copy choice this
   ADR must make).
4. **The `todo-sync/1` wire format is frozen** (ADR-006 contract 2 / R3: any change needs a
   superseding ADR). This ADR is a *child* decision of ADR-006 and therefore **extends no wire
   format** — everything here fits inside the Decision 10 envelope or lives purely locally.

What this ADR settles (the questions the impl card may not invent): algorithm + scope
(per-record vs store-level) and the AAD choice; KDF parameters + iteration policy; the key
hierarchy incl. the recovery key; key lifecycle in session (memory, idle re-lock); the
plaintext/ciphertext metadata split; cross-device key portability; the plaintext→encrypted
migration path; failure modes (wrong passphrase, lost passphrase, corrupt ciphertext); the
enable/disable UX flow around the forced-backup gate; and — explicitly — how conflict copies and
tombstones behave when payloads are encrypted.

---

## Decision summary (the short version)

| Question | Decision |
|---|---|
| Scope | **Per-record** AES-GCM (not store-level) — payload-level, one record = one ciphertext |
| Algorithm | **AES-GCM 256-bit** via WebCrypto `subtle`; 96-bit random IV per encryption (fresh IV on every re-encrypt); **zero new dependencies** |
| AAD | Identity-bound: `todo-enc/1\|<kind>\|<id>` — NOT timestamps (tombstone-while-locked must work). Conflict copies are **re-encrypted while unlocked** (ADR-006 D10 rule 5 option (3)) |
| Key hierarchy | Random 256-bit **DMK** per store, envelope-wrapped by a **passphrase slot** (PBKDF2) and an optional **recovery slot** (HKDF) — re-key = re-wrap one key, never re-encrypt records |
| KDF | **PBKDF2-HMAC-SHA-256, 600,000 iterations**, 16-byte random salt per slot (OWASP 2023); params stored per slot; floor raises upgrade lazily on next unlock. Argon2id = WASM = rejected (§9.2) |
| Recovery key | 256-bit random secret, Crockford base32 code (56 chars, checksummed) **and** a downloadable `todo-key/1` key file ("emergency kit"); HKDF-SHA-256 → recovery KEK. Offered optionally per §7.3 |
| Cross-device keys | **Key file transfer (user-mediated)** — new devices join via the key file or a backup export. Wrapped-key sync records would extend the frozen `todo-sync/1` wire → deferred to `todo-sync/2` (recorded alternative) |
| Metadata split | Plaintext: ADR-006 envelope (`id`, `kind`, `updatedAt`, `deviceId`, `deletedAt`, `payloadHash`, `enc`) + structural fields (`listId`, `status`, `priority`, `dueDate`, `reminderAt`, `recurrence`, `parentTaskId`, `sortOrder`, `createdAt`, `completedAt`). Ciphertext: **user text** — `title`, `notes`, `tags` (Task); `name` (List) |
| Key lifecycle | Memory-only DMK (non-extractable `CryptoKey` where wrapping allows; raw bytes never persisted outside slots), per tab; **idle re-lock default 15 min** (5/15/30/60 configurable) + manual "Lock now"; lock drops decrypted caches + search index |
| Migration | Forward-only enable sweep: per-record enc flag (mixed states legal), `status: off\|migrating\|on`, batched atomic txs, idempotent, crash-resumable; **every migrated record gets a fresh `updatedAt` stamp** so the ciphertext wins LWW everywhere. Disable = decrypt-all sweep, same stamping |
| Forced backup (§7.3) | **Enable is impossible without a fresh export**: gate = `settings.lastBackupAt` recorded *after* the enable flow opened. Plus typed/checked "lost passphrase = unrecoverable" confirmation and the recovery-key offer |
| Exports | **Always plaintext** (a backup that needs the lost passphrase is no backup); require unlocked; ADR-004's `formatVersion: 2` + `crypto` block stays reserved future work. Internal snapshot payloads in IDB **are encrypted at rest** when C1 is on (they hold full user text) |
| Wrong/lost passphrase | Wrong → `UNLOCK_FAILED`, retryable, nothing touched. Lost → three explicit paths: recovery key file, restore from backup export, or (honest) unrecoverable |
| Sync credentials | `sync_state.remotePassword` stays **plaintext in IDB** (ADR-006 Decision 7 status quo) — wrapping it would break the binding "tombstones propagate locked" rule (Decision 8.4) |
| Storage | New local-only singleton store `crypto_state` via the ADR-002 chain: **idbVersion 3 / schemaVersion 3**, additive + pre-migration snapshot; excluded from export/snapshot/remote like `meta`/`sync_state` |

---

## Decision 1 — Scope and algorithm: per-record AES-GCM over user text

**Per-record, payload-level AES-GCM-256** (WebCrypto `subtle.encrypt/decrypt`, `AES-GCM`,
256-bit key). One record = one ciphertext + one IV. NOT store-level.

Rationale over store-level (see Alternatives): ADR-006's binding envelope is per-record — the
merge engine, tombstones, and shadow test need the envelope fields readable without keys, and the
wire unit is the full-record state version. Store-level encryption would encrypt the whole object
store as a blob: every write re-encrypts everything, a torn write endangers the whole dataset,
sync would ship one opaque blob (no LWW, no tombstones, no conflict copies), and boot validation
could not quarantine per record. Per-record is also the granularity §7.3 names ("per-record or
store-level encryption of titles/notes") — and per-record wins on every axis that matters here.

### 1.1 IV and parameters

- **IV: 96-bit random per encryption** (`crypto.getRandomValues`, 12 bytes), a fresh IV on every
  encryption including re-encrypts. Random 96-bit IVs are safe for AES-GCM far beyond our scale
  (birthday bound ≈ 2^32 encryptions under one key; our budget is 10k tasks × a bounded number of
  edits — and IV reuse is structurally prevented because every encrypt draws fresh randomness).
- **Key: 256-bit AES-GCM** (Decision 2). **Tag: 128-bit** (WebCrypto default — full tag, no
  truncation).
- Encoded in the record as the ADR-006 envelope prescribes: `enc: { alg: 'AES-GCM', v: 1, iv }`
  (iv base64) + `payload` (base64 ciphertext+tag). `v` is the payload-envelope version — bumping
  it is the migration hook for any future payload-format change.

### 1.2 AAD — identity-bound, deliberately excluding merge metadata

`AAD = UTF-8("todo-enc/1|" + kind + "|" + id)` (e.g. `todo-enc/1|task|01J…`).

Two properties this buys, and one it deliberately forgoes:

- **Ciphertext is bound to its record identity**: copying a `payload` into a different record
  (id or kind swapped) fails authentication — a same-origin script or a hostile import cannot
  silently transpose contents between records. The decrypt-side test for this is in the testing
  contract.
- **Mutable merge metadata stays outside the AAD on purpose.** `updatedAt`, `deviceId`, and
  `deletedAt` must change **without the key** — tombstoning while locked is binding (ADR-006 D10
  rule 2) and LWW stamping must never require a decrypt. If AAD bound timestamps, every stamp
  would force re-encryption and locked tombstoning would be impossible.
- Forgone: binding the ciphertext to the exact envelope version. The envelope is authenticated by
  nothing — a tamperer can rewrite `updatedAt`/`deletedAt` in place (LWW/tombstone spoofing).
  Recorded honestly: C1 is a **confidentiality** control against snooping (§7.1 case (c)), not an
  integrity control against an attacker with write access to the profile — that attacker could
  also delete the whole database. Do not oversell it in UI copy.

### 1.3 The ADR-006 Decision 10 rule-5 choice (explicit, as required)

ADR-006 rule 5: *"either the payload must be copyable **verbatim** into a conflict copy (i.e. no
record-id-bound AAD), or copies are re-encrypted while unlocked (3). ADR-007 picks one and states
it."*

**Picked: record-id-bound AAD + re-encryption of conflict copies while unlocked.** Justification:
ADR-006 rule 3 already requires the conflict copy to decrypt the loser and prepend
`"Conflict copy of "` to the title (identical UX to plaintext) — the copy's payload changes, so it
must be re-encrypted anyway; verbatim copying would buy nothing and would drop the cross-record
swap defense. The AAD makes the mechanical rule simple: **a `payload` may only ever live under the
`(kind, id)` it was encrypted for; anything else is a decrypt-by-re-encrypt operation while
unlocked.**

---

## Decision 2 — Key hierarchy, KDF parameters, key slots

Envelope encryption: one random **DMK** (data master key) protects data; credentials wrap the
DMK. Consequences: passphrase change re-wraps one 32-byte key (no record re-encryption, zero sync
traffic), and multiple credentials (passphrase + recovery) can open the same data.

### 2.1 Keys

```ts
// The DMK: AES-GCM-256, generated once per store at enable time (crypto.subtle.generateKey).
// Used for: record payloads (Decision 1), snapshot payloads (Decision 4.4), key-file wrapping.
// Raw DMK bytes exist only at generation/wrap time inside WebCrypto; app code never exports it.
```

- **Passphrase slot**: `KEK = PBKDF2-HMAC-SHA-256(passphrase, salt, iters) → 256-bit AES-GCM key`;
  `wrap = AES-GCM(KEK, iv, dmkRawBytes, AAD "todo-enc/1|wrap|<keyId>|passphrase")`.
- **Recovery slot** (optional but offered per §7.3): the **recovery secret** is 256 random bits
  generated at enable time; `KEK = HKDF-SHA-256(secret, salt="", info="todo-enc/1/recovery-kek")
  → 256-bit AES-GCM key` (HKDF is correct here — the secret is full-entropy; stretching would add
  nothing); wrapped DMK under AAD `"todo-enc/1|wrap|<keyId>|recovery"`.
- Wrap AADs bind each wrapped blob to its slot kind so slots cannot be transposed.

### 2.2 KDF parameters and iteration policy

| Parameter | Value | Rationale |
|---|---|---|
| KDF | **PBKDF2-HMAC-SHA-256** (WebCrypto `deriveBits`) | Native (§7.3/§9.2 — no WASM); boring; universally available in the browser floor |
| Iterations | **600,000** for passphrase slots | OWASP 2023 recommendation for PBKDF2-HMAC-SHA-256; measured cost on Moto-G-class hardware ≈ 1–3 s (unlocked once per session — outside the §9.1 INP budget, which covers core interactions; unlock shows a progress state, `deriveBits` runs off the main thread) |
| Salt | 16 random bytes per slot (base64 in the slot) | Unique per slot; stored with the slot (salts are public) |
| Output | 256-bit AES-GCM KEK | Matches DMK size |
| Recovery secret | 256 random bits | High-entropy code; HKDF, not PBKDF2 |

**Iteration policy**: the exact params live **per slot** (`kdf: { v: 1, alg: 'PBKDF2-HMAC-SHA-256',
iters, salt }`), so old slots keep unlocking after the floor rises. A build with a higher floor
**re-wraps lazily**: on successful unlock with `slot.iters < currentFloor`, derive at the old
count, then immediately re-derive at the new count and overwrite the slot (one extra write, no
record touched). A stored `iters` above the floor is always honored (never silently downgrade).
`kdf.v` versions the parameter block itself for future algorithm moves (e.g. a hypothetical
post-WASM-budget Argon2id would be `v: 2`, with a lazy upgrade identical to the iteration one).

### 2.3 Key ring (mixed-key escape hatch)

`crypto_state` holds a **small key ring: 1..N wrapped DMKs**, each with its own slots:

```ts
type KeyEntry = {
  keyId: string;                 // ULID, minted at DMK generation
  slots: KeySlot[];              // exactly one 'passphrase' + 0..1 'recovery' per key
  createdAt: number;
};
type KeySlot =
  | { kind: 'passphrase';
      kdf: { v: 1; alg: 'PBKDF2-HMAC-SHA-256'; iters: number; salt: string };
      wrap: { iv: string; ct: string }; createdAt: number }
  | { kind: 'recovery';
      kdf: { v: 1; alg: 'HKDF-SHA-256'; info: 'todo-enc/1/recovery-kek' };
      wrap: { iv: string; ct: string }; createdAt: number };

type CryptoState = {
  id: 'crypto';                  // singleton, out-of-line key 'crypto' (like meta)
  status: 'off' | 'migrating' | 'on';
  enabledAt: number | null;
  migration: { startedAt: number; done: number; total: number } | null;
  keys: KeyEntry[];              // steady state: length 1 (Decision 3.3 explains the >1 case)
  recoveryOfferedAt: number | null;   // 'declined' is derivable: enabled && no recovery slot
  lockAfterMinutes: number;      // 5 | 15 | 30 | 60 — idle re-lock (Decision 5)
};
```

Normal stores have exactly one key. The ring exists so a store that somehow contains ciphertext
from **two independently-enabled devices** (Decision 3.3) stays fully readable once both keys are
in the ring — decrypt tries ring keys in order on authentication failure only. Consolidating to
one key ("Re-key & consolidate", re-encrypt all records under the first ring key) is an explicit
settings action that stamps records like any migration (Decision 7.2) — it is never automatic.

### 2.4 Storage of key material (local-only)

- `crypto_state` is a new singleton store added through the ADR-002 Decision 8 chain as
  **idbVersion 3 / schemaVersion 3** (chain step "to 3" — after `sync_state`'s step "to 2";
  steps are numbered in canonical decision order and never renumbered; if the encryption impl
  ships before the sync impl it must also register the additive step-2 store creation, which is
  harmless). Structural part (`crypto_state` store) in `onupgradeneeded`; logical record seeded in
  the step's single atomic tx; **pre-migration snapshot first** per the chain.
- Like `meta`/`settings`/`sync_state`: **local-only** — excluded from exports, snapshot payloads,
  and the sync remote. The remote never sees wrapped keys (until a future `todo-sync/2`, see
  Decision 3).
- Wrapped DMKs + kdf params + salts are stored; **raw DMK bytes never touch IndexedDB**.

---

## Decision 3 — Key portability across devices (and the recovery key)

### 3.1 The recovery key artifact — "emergency kit"

Per §7.3 an optional recovery key is **offered** at enable time. One artifact serves both
recovery and device-join:

1. **Recovery code** — the 256-bit secret rendered in Crockford base32 (no I/L/O/U), 52 chars
   + 4-char checksum (first 2 bytes of SHA-256 of the secret, base32) = **56 chars shown as 14
   groups of 4**. Checksum catches typos at entry before any crypto runs. Displayed once, with
   print/copy affordances.
2. **Key file** — a small JSON download `todo-recovery-key-<YYYYMMDD>.json`:

```json
{
  "format": "todo-key/1",
  "createdAt": 1792758000000,
  "keyId": "01J…",
  "recoveryCode": "M4RK … (the same secret, for typed recovery)",
  "kdf": { "v": 1, "alg": "PBKDF2-HMAC-SHA-256", "iters": 600000, "salt": "…" },
  "wrappedDmk": { "iv": "…", "ct": "…" }
}
```

The key file contains the recovery-wrapped DMK **and** the secret — it is a complete emergency
kit (like a 1Password emergency kit): anyone holding the file holds the data. UI copy says so.
The recovery-code path unwraps via HKDF; the key-file path can either use its embedded
`recoveryCode` or just the pre-wrapped blob (which still needs the secret to unwrap — the file
carries both, so the file alone suffices).

**Declining** the recovery key is allowed (§7.3 says "offered", not "mandatory") but re-warns:
"Without this key, forgetting your passphrase is unrecoverable and a new device can only join by
restoring a backup export." The decline is recorded (`recoveryOfferedAt`, no recovery slot).

### 3.2 New-device join flows

When a device pulls records it cannot decrypt (or the user opens "Set up encryption on this
device"):

1. **Key file / recovery code** (recommended): `joinWithKeyFile(file, localPassphrase)` — unwrap
   the DMK (recovery slot), then create a **local passphrase slot** wrapping that same DMK (the
   local passphrase may be the same string as the other device's — a user convention we do not
   enforce and cannot verify). Nothing on the remote or local store changes.
2. **Restore from backup export** (plaintext, Decision 4.5): full restore, then enable fresh on
   this device — which mints a NEW DMK and re-encrypts everything (stamped, propagates via sync
   per Decision 7.2). Only works if the other device's later edits are expendable.
3. There is no passphrase-only join (that would need wrapped slots on the wire — see 3.4). The
   enable wizard says so at the moment it matters: *"Save your key file — you'll need it to open
   this data on another device."*

### 3.3 Independent enable on two devices (the mixed-key case)

If two devices each run the enable wizard before ever syncing, each mints its own DMK; after they
sync, the store contains ciphertext for **two keyIds** and neither device can read the other's
records. Handling (this is why Decision 2.3's key ring exists): the affected device shows a clear
blocked state — *"Some data was encrypted on another device with a different key"* — and the fix
is non-destructive: add the other device's key file to the ring (then everything decrypts;
"Re-key & consolidate" optionally unifies). To keep this rare, the enable wizard warns when sync
is configured: *"Enable this on ONE device first, then join your other devices with the key
file."*

### 3.4 Why keys do NOT ride the sync wire (recorded alternative)

Wrapped-key sync records (`kind: 'keyslot'`) would give passphrase-only joins (Bitwarden-style
vault sync). Rejected **for now**: ADR-006 freezes `todo-sync/1` (R3 — any change needs a
superseding ADR), and its `SyncRecord` kind is a closed `'list' | 'task'` union; old clients
meeting an unknown record kind have defined-nothing behavior. A user-mediated key file achieves
the same security with zero wire change. If passphrase-only joins later justify the cost, the
path is `todo-sync/2` (its `SYNC_FORMAT_NEWER` hard-stop rule already protects old clients) or a
superseding ADR — **not** an impl-card side channel.

---

## Decision 4 — Plaintext / ciphertext metadata split

The binding split is ADR-006 Decision 10's envelope; this decision fills in the payload contents
and the local-storage consequences. Principle: **merge/sync metadata and query structure stay
plaintext; user-authored text is ciphertext.**

### 4.1 Record shape (encrypted variant — replaces ADR-002's `Task`/`List` content fields)

```ts
type Task = {
  // — plaintext envelope (binding, ADR-006 D10) —
  id: string; kind: 'task';
  updatedAt: number; deviceId: string; deletedAt: number | null;
  payloadHash: string;                       // sha256 over `payload` string bytes (base64)
  enc: { alg: 'AES-GCM'; v: 1; iv: string };
  payload: string;                           // ciphertext of TaskPayload
  // — plaintext structural fields (query/merge/schedule) —
  listId: string; status: TaskStatus; priority: Priority;
  dueDate?: string; reminderAt?: number; recurrence?: Recurrence;
  parentTaskId?: string; sortOrder: string;
  createdAt: number; completedAt?: number;
};
type TaskPayload = { title: string; notes: string | null; tags: string[] };

type List = {
  id: string; kind: 'list';
  updatedAt: number; deviceId: string; deletedAt: number | null;
  payloadHash: string; enc: { alg: 'AES-GCM'; v: 1; iv: string }; payload: string;
  color: string; sortOrder: string; createdAt: number;
};
type ListPayload = { name: string };
```

Records are **self-describing**: `enc` present = encrypted. Mixed stores (some records plaintext)
are legal and required for crash-safe migration (Decision 7). `validate.ts` (ADR-002 Decision 11)
gains the two encrypted shapes as accepted variants — same caps on decrypted fields, enforced at
decrypt time (an oversized `title` inside a valid ciphertext is rejected then, quarantined, never
crashed on).

### 4.2 Why these payload contents (and what leaks)

- Ciphertext = **user text** (§7.3: "titles/notes"; extended to `tags` and list `name` because
  they are equally user-authored text — a tag like `therapy` or a list named `Job hunt` is the
  exact content the Privacy Custodian (P2) wants hidden).
- Everything structural stays plaintext so the app remains *operable* while locked and the ADR-002
  indexes (`by_listId`, `by_status`, `by_dueDate`, `by_updatedAt`, `by_list_sort`, `by_parent`)
  keep working unchanged: lists/sorting/counts/Today-Upcoming views render with placeholders,
  due-date notifications can still fire, merge runs without keys (ADR-006 D10 rule 1).
- **Leak inventory (accepted, documented — do not oversell)**: an observer with IDB read access
  sees record counts, list membership, statuses, priorities, due dates/reminder instants,
  timestamps, ordering, recurrence shape, tags' *count*, and the fact that encryption is on. Only
  the words are hidden. Encrypting `dueDate`/`recurrence`/`tags` entirely is possible later at
  the cost of every index and view; §7.3 scopes C1 to titles/notes and this ADR does not exceed
  it. If the PO ever wants the stricter split, it is a payload-shape change via `enc.v` + a
  migration — the door is open, the cost is recorded.

### 4.3 Locked-state UI contract (for the UI cards)

While locked the app shows a **dedicated locked screen** (unlock action + storage/sync status),
not blurred lists: partial rendering of structural fields invites inference and complicates a11y.
The in-memory **search index (ADR-003) is built from decrypted content on unlock and dropped on
lock** — no decrypted text survives in JS heaps longer than the unlocked session (best-effort;
see Decision 5.3).

### 4.4 Snapshot payloads are encrypted at rest

`snapshot_payloads.payload` (ADR-002 Decision 3.6) is a full user-text dump — auto snapshots
(rolling last-3) exist most of the time, so leaving them plaintext would leak everything and
defeat C1. Rule: when `crypto_state.status === 'on'`, the snapshot payload string (which remains
byte-identical ADR-004 export-format JSON **inside** the envelope) is stored as
`AES-GCM(DMK, iv, payloadJson, AAD "todo-enc/1|snapshot|<snapshotId>")`. `snapshots` metadata
(size, time, reason) stays plaintext. Snapshot **restore** requires unlock. This is a scoped
refinement of ADR-002 D3.6's "byte-identical to export format": the plaintext inside the wrapper
is byte-identical; the at-rest wrapper is defined here (crypto owns at-rest representations).

### 4.5 Exports are always plaintext (constraint on ADR-004)

The **backup export file is plaintext by definition** — a backup that cannot be read without the
lost passphrase is not a recovery path (§7.3's forced backup and §7.4 portability both demand it).
Consequences:

- Export requires the store **unlocked** (and, pre-enable, it is trivially available); export
  while locked surfaces an unlock prompt, never a silently truncated file.
- The export dialog warns: *"This file is NOT encrypted — anyone who opens it can read your
  tasks."*
- ADR-004 reserved `formatVersion: 2` + a `crypto` envelope block for a future **encrypted
  export** — stays reserved; C1 does not ship it (an encrypted backup is a fine *additional*
  artifact later, never a replacement for the plaintext one).
- Import into an encrypted store: validated plaintext records are **re-encrypted on write**
  (Decision 7.2 stamping applies) and require unlock; import into a locked store prompts unlock.
  The pre-import snapshot (ADR-002/ADR-004) is itself protected per Decision 4.4.

### 4.6 Row sealing is staged OUTSIDE live transactions (the E10-Q6 rule)

The row seam's `readRow`/`writeRow` are **real async work** (WebCrypto), and an IndexedDB
transaction that awaits real async work **deactivates**: the continuation lands after the
auto-commit window, so subsequent requests are refused (`InvalidStateError` /
`TransactionInactiveError`) — or, worse, the already-issued deletes commit while the seam
writes never land (the silent partial apply of E10-Q6). Whether this bites depends on the
engine's promise scheduling: **chromium** resolves a small seal/digest as a microtask (the
transaction survives); **firefox and webkit** do not (measured first-hand —
`tests/e2e/e10-encryption.spec.ts` tx-lifetime + seamed-tx probes, per-engine pinned).
`fake-indexeddb` sides with firefox/webkit.

**Normative rule: the seam transform never runs inside a live transaction.** Multi-row seamed
applies (import apply / snapshot restore, ADR-004 Decision 5 stage 6) **stage** every row
first — `AppDBImpl.sealForWrite` applies exactly the transform `put` would (including the
locked-write `BLOCKED` refusal) with no transaction open — then write the at-rest bytes
**verbatim** in ONE `txRaw` transaction. Staging is pure (no side effects, nothing to roll
back), so ADR-004 Decision 5's ONE-transaction atomicity contract and the Decision 4.1
at-rest bytes format are both unchanged; a staging refusal fails the whole apply with zero
writes.

Consequences:

- Multi-row seamed applies are engine-independent — chromium's microtask resolution is a
  scheduling accident, not a contract, and must never again be load-bearing.
- **Follow-up carried through (t_a155ebf2): the repo surface, `purge.ts` and the migration
  chain no longer run the seam inside a transaction either.** Repo reads use the safe
  surface (`db.get`/`getAll`/`query` — decrypt after their own tx); single-row
  read-modify-writes (patch/setDone/move/rename/recolor, and `completeRecurring`'s done half)
  commit via `guardedSealedPut` — seal outside, ONE `txRaw` put, guarded by the
  envelope-level `updatedAt` stamp (mismatch → typed retryable `RULE: STALE_WRITE`); bulk
  writes (remove cascade, rebalance hatch, sweepTag, upsertImported, `restore`) stage every
  row and commit verbatim in one `txRaw` — the same pattern as `runSweep`/`applyImport`.
  Residual (open question on t_a155ebf2): the stamp guard cannot see a writer that stamps the
  SAME `updatedAt` (same millisecond / frozen clock), and the pessimistic single-tx
  serialization that produced the §10 E5 two-tab same-record merge is gone by design — the
  e2 tabsync probe pins the collision for h_senior_coder's ruling. `purge.ts` reads
  envelope-level fields only (`id`, `deletedAt` — plaintext in both row shapes), so its pass
  runs over `txRaw` with identical behaviour. The migration chain runs its steps over
  `txRaw` — the "migrations via `txRaw`" half of the `cryptoSeam.ts` contract is now real;
  the v3 step is structurally unreachable with the seam live (C1 requires `crypto_state` =
  schemaVersion 4; boot migrates before `features/crypto/wiring` registers the seam), pinned
  by a macrotask-seam boot probe. At-rest bytes format (Decision 4.1) and every write set's
  ONE-transaction atomicity are unchanged; the e2e repo-path drill (create + patch + setDone +
  tombstone into a REAL encrypted store) passes on all 4 playwright projects.
- The rule ratifies what the code already did deliberately elsewhere: `queryWith` decrypts
  AFTER `base.done`, and the C1 migration sweep (`src/crypto/migrate.ts`) transforms outside
  and applies through `txRaw`.

---

## Decision 5 — Key lifecycle in session

### 5.1 Unlock / lock model

- The DMK lives **in memory only**, per tab (module-scoped `CryptoKey`; app code never calls
  `exportKey` — a lint/review rule; wrap/unwrap happens through `subtle.wrapKey/unwrapKey` and
  generation through `subtle.generateKey`).
- **Per-tab unlock** (accepted friction): each tab holds its own key; a second tab prompts on
  first read. BroadcastChannel key-sharing is deliberately out (key material on a channel is a
  needless exposure surface for zero product gain at stretch scope); the lock/unlock *signal*
  (not the key) may be broadcast so tabs show consistent banners.
- `LockState` as a `@preact/signals` signal (ADR-001) for UI binding:

```ts
type LockState =
  | { status: 'disabled' }                       // C1 not enabled — the app is today
  | { status: 'unlocked'; keyIds: string[] }
  | { status: 'locked'; since: number };
```

### 5.2 Idle re-lock (§7.3: "key held in memory per session, re-lock on idle")

- **Default: lock after 15 minutes without user input**; user-configurable 5 / 15 / 30 / 60.
  ("Never" is not offered — it silently converts the feature into security theater.)
- Idle = no `pointerdown` / `keydown` / `scroll` / `visibilitychange→visible` for the window
  (cheap throttled listeners reset a timer).
- **"Lock now"** button always available; tab close/refresh locks for free (memory gone).
- On lock: drop the DMK reference, **drop decrypted caches and the search index**, signal
  `locked`; the next read path shows the locked screen. A 60-second pre-lock toast ("Locking
  soon — keep working?") prevents mid-edit surprise.

### 5.3 Memory hygiene (honest caveat)

JavaScript cannot reliably zero memory; decrypted strings live until GC. What we actually
guarantee: the key is non-extractable to page JS where wrapping permits (raw DMK bytes exist only
inside WebCrypto during generation/wrap), decrypted plaintext is confined to the repo read path +
search cache and is dropped on lock, and no plaintext is persisted (Decisions 4.4/4.5 govern the
only two persistence outlets). This matches the threat model (§7.1) — it is a snooping control,
not a runtime-compromise control.

---

## Decision 6 — Enable / disable UX (§7.3 verbatim, mechanically enforced)

### 6.1 Enable wizard (order is normative)

1. **Forced backup export (hard gate).** The wizard cannot reach step 2 until an export has
   completed *in this flow*. Mechanism: the flow records `flowOpenedAt`; the export completion
   writes `settings.lastBackupAt` (existing ADR-002 field); the gate passes iff
   `lastBackupAt ≥ flowOpenedAt`. A pre-existing old backup does **not** satisfy the gate (the
   point is a *fresh* pre-encryption copy). Export is one click from the wizard (navigating to it
   does not lose wizard state).
2. **Explicit lost-passphrase warning.** Unskippable copy: *"If you forget your passphrase and
   lose your recovery key, your data is UNRECOVERABLE. There is no password reset — we have no
   server."* Confirmation is a checkbox **and** the primary button stays disabled until it is
   ticked (§7.3: warn explicitly — a passive paragraph is not a warning).
3. **Passphrase entry**: min 12 characters (NIST SP 800-63B-style length-over-composition; no
   forced rotation), confirm field, advisory strength hint (simple length/charset estimate —
   zero-dep, clearly advisory). PBKDF2 runs on submit ("Setting up encryption…" progress).
4. **Recovery key offer** (§7.3: "offers an optional recovery key"): show the recovery code +
   download key file + "I saved it" acknowledgment, or "Skip". Skip re-shows the step-2 warning
   verbatim and records the decline.
5. **Migration runs** (Decision 7) with progress; the wizard closes only when `status: 'on'`.
   Sync-configured warning from Decision 3.3 is shown at step 1.

Failure anywhere before step 5 commits leaves the store plaintext (`status` rolls back to
`off`); the forced export is harmless to have.

### 6.2 Disable (opt-out)

"Turn off encryption" (settings, requires unlock + passphrase confirmation): decrypt-all sweep
(Decision 7.2 mechanics, reverse direction), then keys are wiped from `crypto_state`. The user is
warned their data will be readable to anyone with profile access again. No backup gate (nothing
becomes unrecoverable), but the flow offers one anyway.

### 6.3 Unlock screen and failure copy

- **Wrong passphrase** → `UNLOCK_FAILED`: *"Wrong passphrase."* Retry allowed. PBKDF2's own cost
  is the rate limit (no lockout counters — they punish the legitimate user and stop nobody).
- **Lost passphrase** → a dedicated screen with exactly three honest paths:
  1. *"Use my recovery key"* (code entry with checksum pre-check, or key-file picker).
  2. *"Restore from a backup export"* — re-states what is lost: edits made after that export.
  3. *"I don't have either"* — plainly: data is unrecoverable; the app offers the recovery/export
     paths again and a "delete all data" (§7.4) escape. No fake hope, no support contact (there
     is no support — no telemetry, no server).
- `UNLOCK_FAILED` covers both wrong passphrase and damaged key-slot bytes with that copy;
  distinguishing them is not possible reliably and not useful (both resolve via the same three
  paths).

---

## Decision 7 — Migration: plaintext ↔ encrypted

### 7.1 Shape and state

Mixed stores are legal (Decision 4.1): each record carries its own mode. `crypto_state.status`
tracks the sweep: `off → migrating → on` (and `on → migrating → off` for disable). A `migrating`
store reads normally (encrypted records decrypt when unlocked; when locked, only metadata-level
operations and the locked screen). Boot with `status: 'migrating'` **resumes** the sweep after
unlock.

### 7.2 The sweep (enable direction; disable is the exact inverse)

- **Pre-conditions (atomic with the first batch)**: fresh export gate passed (Decision 6.1),
  keys written (`status: 'migrating'`, `keys: [keyEntry]`), and the chain's **pre-migration
  snapshot** taken (ADR-002 Decision 8/9 — the enable flow is a data migration and uses the same
  machinery; snapshot failure aborts before any record is touched).
- **Batched transactions**: ≤ 200 records per `AppDB.tx(['tasks','lists','snapshot_payloads'],
  'readwrite', …)`; each record: build payload → encrypt (fresh IV, Decision 1.2 AAD) → rewrite
  the row in its encrypted shape → **stamp `updatedAt = clock.now()`, `deviceId` = this device**.
- **Stamping is deliberate (sync semantics)**: the migration is a content-shaping change that must
  win LWW on every other device and propagate as ordinary state versions (ADR-006 wire untouched).
  A remote device without the key then converges to ciphertext it cannot read and shows its own
  "encrypted data — key needed" flow (Decision 3.2) — honest and deterministic, instead of
  eternal plaintext/ciphertext byte divergence at equal `(updatedAt, deviceId)`. Disable stamps
  the same way (plaintext version wins everywhere).
- **Idempotent + crash-safe**: a record already in the target mode is skipped; a crash mid-sweep
  leaves a mixed store the app fully supports; resume recomputes progress from a scan. Batch
  atomicity (ADR-002 `tx`) means no half-encrypted record can exist.
- **Quota**: overwriting rows in place barely grows the store (ciphertext ≈ payload size + ~28
  bytes overhead/record); `QUOTA_EXCEEDED` anywhere maps to the ADR-002 §5.5 dialog (export /
  cleanup) and the sweep pauses resumably — never a silent partial state.
- **Tombstoned rows are swept too** (they hold user text in `payload`), keeping their
  `deletedAt`; their `updatedAt` stamp does not disturb tombstone semantics (a newer tombstone is
  still a tombstone).

### 7.3 Compatibility with pre-encryption builds (honest)

A stale pre-C1 build opening `enc`-shaped rows fails its `validate.ts` shapes → the ADR-002
Decision 8 step-4 boot validation **quarantines non-destructively** (no crash, no data loss,
recovery JSON downloadable). Since C1 is stretch and ships after MVP/V1, mixed-version windows are
rare and their behavior is safe. Mitigation: the settings screen states the app version that
enabled encryption; the update flow (ADR-005) keeps users current.

---

## Decision 8 — Sync interop under encryption (explicit answer: conflict copies & tombstones)

This is the binding-conformance section to ADR-006 Decision 10. Everything below follows from the
envelope split + the identity-bound AAD (Decision 1.2).

### 8.1 What runs without keys (locked or unlocked — unchanged from ADR-006)

LWW comparison on `(updatedAt, deviceId)`, tombstone propagation, the shadow three-way test
(with `payloadHash` in the shadow's `contentHash` slot — same entry shape as ADR-006 Decision 3),
cursors, batching, snapshots-as-compaction: all operate on the plaintext envelope only. A locked
device **pushes and pulls ciphertext verbatim** (payloads are opaque strings to the engine).

### 8.2 Tombstones (explicit answer)

- **A tombstone is pure envelope**: setting `deletedAt` changes no payload, needs no key, and
  (crucially, per Decision 1.2) requires no re-encryption — this is exactly why AAD excludes
  timestamps. **Tombstoning works while locked; deletions propagate while locked** (ADR-006 D10
  rule 2 satisfied).
- The ciphertext `payload` is kept on the tombstone (undo-friendly; purged with the row after 90
  days / explicit cleanup, ADR-002 Decision 6 — purge needs no key either).
- Delete-vs-delete: unchanged. **Delete-vs-edit** (see 8.3): the tombstone outcome follows LWW on
  the id, and the edited version's preservation as a conflict copy requires the key — so the run
  defers while locked (8.4) rather than dropping the edit.

### 8.3 Conflict copies (explicit answer)

A conflict copy is **always a decrypt → modify → re-encrypt operation** (unlocked only):

1. Decrypt the losing version's `payload` under the ring key (its `keyId` is found by trying the
   ring — normally N=1).
2. Build the new row per ADR-006 Decision 4.3 verbatim: fresh ULID, `title = "Conflict copy of "
   + loser.title` (1000-char cap), other payload fields from the loser, structural fields copied,
   `createdAt/updatedAt = now`, `deviceId` = this device, `deletedAt = null`.
3. Encrypt the new payload with a **fresh IV** under AAD `todo-enc/1|task|<newId>` — the identity
   binding is what makes the copy a first-class record rather than a byte-clone.
4. It lands in the same single apply transaction as the merge plan (ADR-006 Decision 4.4) and
   syncs out like any local create.

The UX is identical to plaintext (ADR-006 D10 rule 3): visible rows, `conflictsCreated: n` in the
run summary, `conflicts-pending` until acknowledged.

### 8.4 Locked runs — deferral rule (concretized)

ADR-006 D10 rule 3: content merge/conflict copies require the key; the engine "defers with
`LOCKED`". Exact rule:

- A merge run whose apply plan requires **zero** conflict copies applies normally while locked
  (envelope-only plan).
- A run whose plan requires **≥ 1** conflict copy **defers entirely** with `LOCKED` (no partial
  apply — atomicity of Decision 4.4 is preserved; the run resumes on unlock and re-merges
  idempotently from the cursors). `LOCKED` is not an error banner (ADR-006 Decision 6) — a quiet
  "waiting for unlock" status.

### 8.5 Worked example (ADR-006's four cases, encrypted)

Same "Buy milk" scenario, payloads ciphertext. A renames ("Buy oat milk", `updatedAt 2000`), B
adds notes (`updatedAt 1900`):

1. **Edit vs edit** → unmergeable. R wins the id (LWW); the loser (B's version) becomes a
   *new* record: decrypted → `"Conflict copy of Buy milk"` + B's notes → re-encrypted under the
   new id/IV. Requires unlock (8.4). Both edits visible on both devices after sync.
2. **LWW tie** (`updatedAt` equal) → deviceId lexicographic winner keeps the id; the loser is
   copied per 8.3. Deterministic on both devices — and note both devices independently create
   their own copy rows (ADR-006's accepted duplicate), each under its own key/IV.
3. **Delete vs edit** → tombstone wins the id (propagated even from a locked device — pure
   envelope); the edit is preserved as the 8.3 copy when an unlocked device processes the merge.
   Locked processing defers (8.4) — the edit is never dropped.
4. **Delete vs delete** → newer tombstone wins; no copy; **works entirely while locked**.

**Degraded identical-edit detection** (ADR-006 D10 rule 4, restated): two devices making the same
edit produce different ciphertext bytes (`payloadHash` differs), so the shadow test cannot
demote it to "same change" — it reports concurrent edit → conflict copy. Safe direction
(possibly-redundant visible copy, never silent loss). Accepted.

### 8.6 Re-encryption churn vs the shadow map

`payloadHash` changes on **every** re-encryption, but the shadow test's change detection keys on
`(updatedAt, deviceId)` equality first. Rules that keep churn from causing phantom conflicts:

- Migration/re-key/consolidation **stamp** `updatedAt` (Decision 7.2) — a deliberate version
  bump the shadow absorbs as "one side changed", not as divergence (only *both*-changed creates
  copies).
- Non-stamping re-encryptions (none in this ADR's flows — re-key re-wraps slots only, touching
  zero records) would be shadow-invisible and harmless.

### 8.7 WebDAV credentials stay plaintext (resolution of a real tension)

ADR-006 Decision 7 flagged "app password plaintext in IDB until C1 adds a key". Wrapping it would
break ADR-006 D10 rule 2's binding guarantee — sync runs while locked need the remote password,
and tombstones must propagate while locked. **Decision: `sync_state.remotePassword` remains
plaintext in `sync_state`**; C1 protects task/list content, not the sync credential. Recorded
consequences: the privacy custodian keeps using ADR-006's memory-only mode; a future
`todo-sync/2` (which may also carry key slots, Decision 3.4) can revisit wrapping credentials
together with full locked-sync deferral as a package — not piecemeal.

---

## Decision 9 — Failure modes (normative)

| Failure | Behavior | Data safety |
|---|---|---|
| Wrong passphrase at unlock | `UNLOCK_FAILED`, retry | Nothing touched (slots are read-only here) |
| Lost passphrase + recovery key | Recovery path (code or key file) → prompt new passphrase → **re-wrap DMK under a new passphrase slot** (records untouched — envelope win) | Full recovery |
| Lost passphrase, no recovery key | Three-path screen (Decision 6.3); recovery = restore the forced pre-enable export (loses post-export edits) or unrecoverable | As warned at enable time (§7.3) |
| Corrupt/tampered ciphertext (GCM tag fails **under a successfully unwrapped key**) | Record fails decrypt → **quarantine** (ADR-002 D8 step 4 non-destructive path: excluded from reads, downloadable recovery JSON, purge only explicit) | Never crashed on, never silently dropped |
| Mixed-key store (Decision 3.3) | Blocked banner + "add the other device's key file" | Non-destructive; ring grows to 2 |
| Crash mid-migration | Mixed store; resume on next unlock; no half-records (batch tx) | Idempotent; pre-migration snapshot exists |
| `QUOTA_EXCEEDED` during migration | ADR-002 §5.5 dialog (export/cleanup); sweep pauses resumably | No silent drops |
| Lock while a sync run is mid-flight | Envelope-only phases complete; plan needing copies defers `LOCKED` (8.4) | Apply tx atomicity unchanged |
| Pre-C1 build opens encrypted rows | Validation quarantine (7.3) | Non-destructive |
| Key file from a different store | Decrypt attempts fail → `INVALID_KEY_FILE`/`WRONG_KEY_DOMAIN` copy: "This key file doesn't match this data" | Nothing touched |

Error contract (team baseline — `Result`, never thrown across boundaries):

```ts
type CryptoErrorCode =
  | 'UNLOCK_FAILED' | 'LOCKED' | 'NOT_ENABLED' | 'ALREADY_ENABLED'
  | 'DECRYPT_FAILED' | 'CORRUPT_KEY' | 'INVALID_KEY_FILE' | 'WRONG_KEY_DOMAIN'
  | 'NO_BACKUP'          // enable gate: no fresh export receipt (Decision 6.1)
  | 'MIGRATION_FAILED' | 'QUOTA_EXCEEDED' | 'NEWER_ENVELOPE';  // enc.v from the future
```

---

## Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Store-level AES-GCM (one blob) | Fewer objects; simple | No per-record LWW/tombstones/sync; whole-store rewrite per edit; torn write endangers everything; no per-record quarantine | ADR-006's per-record wire unit + §5.4 recovery model both require per-record granularity |
| Argon2id (WASM) | Memory-hard KDF, best practice | WASM violates §9.2 (0 in MVP; exception "will not be granted") + bundle budget | PBKDF2 at 600k iters + passphrase policy + recovery key is the honest trade; recorded (see Consequences) |
| Deterministic key from passphrase (KEK = DMK) | Same passphrase works on every device with zero key distribution | **No recovery key possible** (nothing random to wrap); passphrase change = re-encrypt everything; passphrase change = data loss risk | §7.3 requires offering a recovery key — that mandates a wrapped random DMK |
| No AAD / unbound payload (verbatim conflict copies) | Conflict copies copyable without keys | Cross-record ciphertext transposition undetected; and copies must re-encrypt anyway (title prefix, ADR-006 D10 rule 3) | Identity binding is nearly free; verbatim copying buys nothing |
| AAD bound to `(updatedAt, deletedAt, …)` | Tamper-evident envelope | Tombstoning/stamping while locked becomes impossible (needs key) — breaks binding ADR-006 D10 rule 2 | Lock-independent metadata changes are non-negotiable |
| Encrypt everything but the envelope | Maximum secrecy | Kills all indexes/views while locked; due-date features dead; search index unusable even unlocked-at-boot; exceeds §7.3 scope | §7.3 scopes C1 to titles/notes; operational structure must survive; leak inventory documented instead |
| Encrypted export files | Safer files at rest | A backup that needs the lost passphrase is no backup (§7.3 forced-backup purpose defeated) | Plaintext export + explicit warning; `formatVersion 2` reserved for an *additional* encrypted artifact later |
| Sync wrapped key slots (`kind: 'keyslot'`) | Bitwarden-style passphrase-only joins | Extends frozen `todo-sync/1` (R3: superseding ADR required); unknown-kind hazard for old clients | Key file keeps the wire frozen; revisit at `todo-sync/2` |
| Per-record DEKs wrapped by DMK | Key rotation per record | Nothing to rotate against (single-user, §12 Q1); 10k wrapped keys of pure overhead | One DMK; re-key = re-wrap one key |
| Lock on `visibilitychange` immediately | Fastest lock | Locks mid-thought on every tab switch; hostile UX → users disable the feature | Idle timer (15 min default) + 60s pre-lock toast + manual lock |
| Auto-lock "never" option | User freedom | Silent security theater | Not offered (5/15/30/60 only) |

---

## Consequences

**Positive**
- Confidentiality for exactly the content §7.3 names, at per-record granularity that keeps the
  ADR-006 sync design (LWW, tombstones, conflict copies) working untouched — the wire never
  changed and never sees keys.
- Envelope encryption makes passphrase change and recovery-key issuance **O(1) key writes, zero
  record re-encryption, zero sync traffic**.
- The forced-backup gate + recovery key + honest unrecoverable copy directly defuse R7
  (lost passphrase = lost data) to the extent software can.
- Zero new dependencies and zero WASM: everything is WebCrypto native (§7.2/§9.2); the crypto
  module is a small lazy-loaded addition to the settings route.
- Crash-safe, resumable migration with mixed-state stores — no flag day, no big-bang rewrite.

**Negative / accepted costs**
- **PBKDF2 is not Argon2id**: a well-resourced offline attacker with a stolen profile + weak
  passphrase has a GPU-cheap KDF to grind. Mitigated (not eliminated): 600k iterations, 12-char
  minimum, strength hint, and the honest "use a strong passphrase" copy. The WASM budget rule is
  the product's decision, recorded here with eyes open.
- **Metadata leak inventory** (Decision 4.2) — structure/timing/dates visible to a profile
  reader. §7.3's scope; documented, not oversold.
- **Key file is the device-join credential** (Decision 3) — more ceremony than "same passphrase
  everywhere" would be, the cost of keeping `todo-sync/1` frozen. The enable wizard makes saving
  it the default path.
- Per-tab unlock (Decision 5.1) — a second tab prompts once per session window.
- JS memory hygiene is best-effort (Decision 5.3).
- Exports are plaintext files on disk — user must treat them like the data (warned at export).

**Risks & mitigations**
- *R7 lost passphrase* → forced fresh export (hard gate) + optional recovery key + three-path
  recovery screen; nothing silently unrecoverable was ever promised.
- *Mixed-key stores from independent enables* → wizard warning when sync is configured + key ring
  + non-destructive "add the other key file" flow.
- *Scope creep (crypto-adjacent features: per-field hiding, encrypted export, key sync)* → each
  needs its own ADR (`enc.v` bump / `formatVersion 2` / `todo-sync/2`); impl cards implement
  exactly this ADR.
- *Impl drift on crypto parameters* → parameters are normative below; any change (iterations,
  KDF, AAD layout) is an ADR revision, not a code-side tuning knob.

---

## Testing contract (for the impl/test cards — normative)

**Unit (Vitest; ≥80% on `src/crypto/` per §9.5):**
1. **Known-answer vectors**: pinned fixtures — fixed DMK/IV/plaintext → exact ciphertext bytes
   (generated once with Node's WebCrypto, committed as test fixtures); PBKDF2-SHA-256 vector
   (published test vector or pinned fixture at the shipped 600k params); HKDF recovery-KEK
   vector; wrap/unwrap round-trips with AAD slot binding (transposed-slot unwrap must fail).
2. **AAD binding negative tests**: a payload encrypted for `(task, idA)` must fail to decrypt
   under `(task, idB)` and `(list, idA)` (Decision 1.3's swap defense).
3. **Unlock/lock**: wrong passphrase → `UNLOCK_FAILED` and slots untouched; recovery-code unlock
   (checksum pre-check catches typos); key-file unlock incl. `WRONG_KEY_DOMAIN`; re-lock drops
   the DMK + decrypted cache + search index (asserted via the LockState signal + cache
   inspection); idle timer math (injectable clock, 60s pre-lock toast).
4. **Forced-backup gate**: enabling with no export receipt is **impossible** (negative test at the
   service layer: `enable()` → `NO_BACKUP`); a stale `lastBackupAt` (before `flowOpenedAt`) does
   not pass; warning checkbox/typed confirmation required; recovery-decline re-warning recorded.
5. **Migration**: plaintext→encrypted fixture sweep (mixed batches, tombstones swept, stamps
   asserted); crash mid-sweep → resume → idempotent completion; disable = inverse; snapshot
   payload encryption round-trip (4.4); quota fault-injection pauses resumably.
6. **Conflict copies under encryption** (pure-logic parts): loser decrypt → title prefix → new-id
   re-encrypt (fresh IV; AAD asserts new id); identical-edit degradation to conflict copy;
   tombstone-without-key path (8.2); zero-copy plan applies locked, ≥1-copy plan defers `LOCKED`
   (8.4).
7. **Quarantine**: corrupt ciphertext under a valid key → quarantine, no crash; oversized
   decrypted field → rejected at decrypt time, quarantined.

**Integration / E2E (Playwright, two contexts = two devices):**
- Enable → forced export → key file saved → records encrypted (assert IDB rows have `enc`, no
  plaintext title anywhere in `tasks`/`snapshot_payloads`).
- Convergence with encryption: A edits → push → B (joined via key file) pulls → visible
  convergence; concurrent edit → exactly one visible "Conflict copy of …" per device with
  decryptable content; delete-vs-edit → edit preserved as copy; **tombstone created on a LOCKED
  device propagates** (8.2); sync while locked with a copy-requiring plan → `LOCKED` defer, no
  partial apply.
- Lost-passphrase drill: wrong passphrase ×N (no damage) → recovery-code unlock → new passphrase
  re-wrap → records unchanged; "no recovery key" screen shows the three honest paths.
- Export while locked → unlock prompt (never a truncated file); export dialog warning visible.

**Audit / budget evidence (attach to the impl card):** dependency audit — **zero new
dependencies** (WebCrypto only); no WASM in the build (existing CI gate unchanged); crypto module
size measured (est. ≤ 4 KB gzip, lazy-loaded — assert against §9.2).

---

## Contracts other cards must implement against (normative summary)

1. **Parameters are normative**: AES-GCM-256 (128-bit tag), 96-bit random IV per encryption,
   AAD `todo-enc/1|<kind>|<id>`, PBKDF2-HMAC-SHA-256 600,000 iters / 16-byte salt for passphrase
   slots, HKDF-SHA-256 (`info: todo-enc/1/recovery-kek`) for recovery slots. Changing any of
   these is an ADR revision.
2. **Envelope compliance**: encrypted records are exactly ADR-006 Decision 10's
   `EncryptedSyncRecord` shape plus the structural fields of Decision 4.1 — no new wire fields.
   The sync engine sees opaque `payload` strings + plaintext envelope; it never imports crypto
   code except behind the `LOCKED` deferral hook (8.4).
3. **`crypto_state`** arrives via the ADR-002 chain at **idbVersion 3 / schemaVersion 3**
   (additive, pre-migration snapshot, step numbered after `sync_state`'s step 2); local-only;
   excluded from exports/snapshots/remote like `meta`/`sync_state`.
4. **Seam layout** (suggested, impl may adjust names not boundaries):
   `src/crypto/{keys,passphrase,recovery,payload,migrate,lock}.ts`; repos decrypt/encrypt at the
   read/write seam only (ADR-002 Decision 10.4 repos stay the single stamping/validation home);
   `validate.ts` learns the encrypted record shapes (Decision 4.1).
5. **Search index (ADR-003)**: built from decrypted content on unlock, dropped on lock
   (Decision 4.3).
6. **Export/import (ADR-004)**: exports plaintext, require unlock, warn in the dialog
   (Decision 4.5); imports into an encrypted store re-encrypt on write with stamping; snapshot
   payloads at rest are encrypted when C1 is on (Decision 4.4) while remaining byte-identical
   ADR-004 JSON *inside* the wrapper.
7. **UX constraints (§7.3) are non-negotiable** and mechanically enforced (Decision 6): fresh
   export gate (test-proven impossible to bypass), explicit lost-passphrase warning with
   confirmation, optional recovery key offered, idle re-lock with a clear locked state.
8. **Errors**: `Result` + `CryptoErrorCode` (Decision 9); `LOCKED` is a quiet deferral state, not
   an error banner (matches ADR-006 Decision 6/9).

---

## Task result handoff (stretch impl card)

**t_db67a322 — Impl: Encryption at rest — WebCrypto AES-GCM + forced-backup & recovery-key UX
(C1)** builds, in this order:

1. Chain migration: `crypto_state` store + seed (Decision 2.4) + `validate.ts` encrypted shapes
   (Decision 4.1).
2. `src/crypto/keys.ts` + `passphrase.ts` + `recovery.ts` (Decision 2: wrap/unwrap, slots, key
   file `todo-key/1`, checksummed recovery code) with KAT fixtures first (testing contract 1–2).
3. `src/crypto/payload.ts` (Decision 1: encrypt/decrypt + AAD + `payloadHash`) — the repo
   read/write seam + `lock.ts` (Decision 5: LockState signal, idle timer, cache drop).
4. Enable/disable wizard + forced-backup gate (Decision 6) — gate negative tests before the UI
   lands (testing contract 4).
5. `src/crypto/migrate.ts` (Decision 7: batched resumable sweeps, stamping) + snapshot-payload
   encryption (Decision 4.4).
6. Sync interop (Decision 8): the `LOCKED` deferral hook into the ADR-006 engine, conflict-copy
   re-encryption path, tombstone-while-locked test.
7. Failure-path suite (Decision 9 table) + two-device E2E convergence + audit/budget evidence.

Acceptance (from the card, mapped): crypto unit tests incl. known-answer vectors → contract 1–3;
wrong-passphrase and re-lock flows → contract 3; forced-backup gate proven → contract 4;
encrypted-records + sync convergence → contract 6 + E2E; failure paths degrade without silent
loss (quarantine/blocked states with evidence) → contract 7 + Decision 9 table; no hand-rolled
primitives, no WASM, dependency audit recorded → audit evidence row.

**Gating note**: t_db67a322 also depends on the sync engine card (t_00d7f17b) and the export
format card for the seams of Decisions 8 and 4.5 — implement the crypto core (steps 1–5) against
the contracts above even if those land later; the interop hooks are narrow and specified.

---

## Links
- PROJECT_ANALYSIS.md §7.3 (binding UX constraints + design sketch), §7.1–7.2 (threat model,
  WebCrypto-only, no-telemetry/dependency policy), §12 Q3 (PO DECIDED: stretch), §6.2 (sync/
  conflict policy), §11 R7 (lost-passphrase risk), §9.2 (0 WASM), §5.4 (migrations), §7.4
  (portability/deletion)
- ADR-006 (WebDAV sync — Decision 10 envelope binding; this ADR is its child decision), ADR-002
  (storage schema, migration chain, Result contract, snapshot payloads), ADR-003 (search index),
  ADR-004 (export container — `formatVersion 2` reserved for a future encrypted export), ADR-005
  (update flow keeping pre-C1 builds current)
- Kanban: epic E10 decomposition t_1b9ee0e6; this card t_55accc9c (sole decider); impl card
  t_db67a322
