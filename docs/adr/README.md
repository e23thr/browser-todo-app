# Architecture Decision Records

This directory holds the project's ADRs: one record per material architectural decision, written
before the affected code lands, by the decision owner. ADRs are append-only; a superseded decision
keeps its record with `Status: Superseded by ADR-NNN` and a pointer.

## Conventions

- **File naming**: `ADR-NNN-short-title.md` (NNN zero-padded, sequential, never reused).
- **Status**: `Proposed` → `Accepted` → (`Superseded by ADR-NNN`). Accepted = the decision binds
  downstream cards; re-opening requires a scope change and a new ADR that supersedes the old one.
- **Ownership**: each ADR names its decider. Framework/toolchain has a single decider
  (h_senior_coder, task t_9fa51c86) — other cards must not re-decide what an accepted ADR settled.
- **Evidence**: prefer measured facts (bundle sizes, timings) over estimates; record how and when
  measured.

## Index

| ADR | Title | Status | Decider | Scope |
|---|---|---|---|---|
| [ADR-001](ADR-001-ui-framework.md) | UI framework & build tooling | **Accepted** (2026-10-23) | h_senior_coder | Preact + signals + Vite + npm + TS strict + ESLint/Prettier + CI matrix + bundle-budget gates + repo layout |
| [ADR-002](ADR-002-storage-schema.md) | Storage schema & IndexedDB wrapper | **Accepted** (2026-10-23) | h_senior_coder | IDB stores/indexes, ULID ids, order keys, tombstones, timestamps, AppDB wrapper + Result/StorageError, migration chain, snapshots (§5.2–5.5) |
| [ADR-003](ADR-003-domain-layer.md) | Domain layer, state & search-index design | **Accepted** (2026-10-23) | h_senior_coder | module boundaries (domain/ports/adapters), repository interfaces, optimistic write pipeline + rollback, single-record reorder, in-memory search index (measured budgets), virtualization, BroadcastChannel tab protocol + watermark sweep, view-models, dueDate all-day semantics (§9.1, §9.3, E5/E6/E7) |
| [ADR-004](ADR-004-export-import-format.md) | Export/import file format & merge semantics | **Accepted** (2026-10-23) | h_senior_coder | backup/recovery document formats + canonical serialization, import pipeline (validate → confirm → pre-import snapshot → replace; MVP replace-only), old-export upgrades via the shared migration chain, quarantine + recovery file, snapshot retention & undo semantics, exact restore path (§5.4, §7.4, E2/E4/E8) |
| [ADR-006](ADR-006-webdav-sync.md) | WebDAV sync protocol & merge engine (V1) | **Accepted** (2026-10-23) | h_senior_coder | remote layout (snapshot + change manifest), pull/push flow, client-side LWW merge + conflict copies, tombstone purge interplay, auth, failure semantics, encrypted-record envelope (§6.2) |
| [ADR-005](ADR-005-service-worker.md) | Service worker & update strategy | **Accepted** (2026-10-23) | h_senior_coder | whole-artifact app-shell precache (deliberately no manifest in MVP — PO Q12), versioned caches + activate purge, cache-first routing + navigation fallback, user-gated update state machine (E9: never force reload mid-edit), `BASE_PATH` scope handling, Playwright offline test strategy (§6.1/§9.5) |
| [ADR-007](ADR-007-encryption.md) | Encryption at rest (stretch C1) | **Accepted** (2026-10-23) | h_senior_coder | per-record WebCrypto AES-GCM + PBKDF2 (600k) key hierarchy, recovery key/key-file, identity-bound AAD, plaintext/ciphertext metadata split (child of ADR-006 D10 envelope), `crypto_state` store, memory-only key lifecycle + idle re-lock, forced-backup + recovery-key UX (§7.3), plaintext↔encrypted migration, encrypted sync interop (conflict copies & tombstones) |

## Planned (required by PROJECT_ANALYSIS.md §9.5)

None outstanding — all seven canonical ADRs are written (001–007).

**Canonical numbering authority** = decomposition card t_1b9ee0e6 (epic split). The provisional
numbering in ADR-001's completion metadata (ADR-003 = service worker, ADR-004 = sync,
ADR-005 = encryption) is **SUPERSEDED** by the list above; do not link to the old numbers.

Planned rows are placeholders with numbers reserved so downstream cards link to stable identifiers;
each is created when its card is worked (none remain — 2026-10-23). A budget exception (WASM)
additionally requires an ADR that updates the `no-wasm` CI gate alongside the payload.
